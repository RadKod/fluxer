// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRenderLoop, type RenderLoopOptions} from '@app/features/voice_scene/scene/VoiceSceneRenderLoop';
import {resolveRoomView} from '@app/features/voice_scene/utils/RoomViewAvailability';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it, vi} from 'vitest';

const voice = vi.hoisted(() => ({disconnect: vi.fn()}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: vi.fn(() => Promise.resolve())}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: voice}));

const {default: VoiceSceneSettings} = await import('@app/features/voice_scene/state/VoiceSceneSettings');

const FRAME_60HZ = 1000 / 60;

function harness(draw: () => boolean = () => false) {
	let now = 0;
	let nextId = 0;
	const queue = new Map<number, FrameRequestCallback>();
	const doc = Object.assign(new EventTarget(), {hidden: false});
	const canvas = new EventTarget();
	const onContextLost = vi.fn();
	const drawSpy = vi.fn(draw);
	const options: RenderLoopOptions = {
		draw: drawSpy,
		canvas,
		onContextLost,
		doc,
		requestFrame: (callback) => {
			queue.set(++nextId, callback);
			return nextId;
		},
		cancelFrame: (id) => {
			queue.delete(id);
		},
	};
	const loop = createRenderLoop(options);
	return {
		loop,
		draw: drawSpy,
		onContextLost,
		canvas,
		setHidden(hidden: boolean) {
			doc.hidden = hidden;
			doc.dispatchEvent(new Event('visibilitychange'));
		},
		frames(count: number) {
			for (let i = 0; i < count; i++) {
				now += FRAME_60HZ;
				const callbacks = [...queue.values()];
				queue.clear();
				for (const callback of callbacks) callback(now);
			}
		},
		pendingFrames: () => queue.size,
	};
}

describe('VoiceSceneRenderLoop (Ş7)', () => {
	it('no frames while idle', () => {
		const h = harness();
		h.frames(120);
		expect(h.draw).not.toHaveBeenCalled();
		expect(h.pendingFrames()).toBe(0);
	});

	it('requestRender draws one frame', () => {
		const h = harness();
		h.loop.requestRender();
		h.loop.requestRender();
		h.frames(30);
		expect(h.draw).toHaveBeenCalledTimes(1);
		expect(h.pendingFrames()).toBe(0);
	});

	it('frames capped at 30 fps during damping', () => {
		// draw() reports the camera still settling on every frame: the worst case, continuous motion.
		const h = harness(() => true);
		h.loop.requestRender();
		h.frames(60);
		expect(h.draw.mock.calls.length).toBeGreaterThanOrEqual(29);
		expect(h.draw.mock.calls.length).toBeLessThanOrEqual(30);
	});

	it('stops once damping settles', () => {
		let settling = 3;
		const h = harness(() => --settling > 0);
		h.loop.requestRender();
		h.frames(60);
		expect(h.draw).toHaveBeenCalledTimes(3);
		expect(h.pendingFrames()).toBe(0);
	});

	it('hidden tab stops frames and resumes once on visible', () => {
		const h = harness(() => true);
		h.loop.requestRender();
		h.frames(4);
		const drawnBeforeHide = h.draw.mock.calls.length;
		h.setHidden(true);
		h.loop.requestRender();
		h.frames(60);
		expect(h.draw.mock.calls.length).toBe(drawnBeforeHide);
		expect(h.pendingFrames()).toBe(0);
		h.draw.mockImplementation(() => false);
		h.setHidden(false);
		h.frames(30);
		expect(h.draw.mock.calls.length).toBe(drawnBeforeHide + 1);
	});

	it('webglcontextlost switches to the flat view with reason context_lost and keeps the call', () => {
		const h = harness(() => true);
		h.onContextLost.mockImplementation(() => VoiceSceneSettings.reportFailure('context_lost'));
		h.loop.requestRender();
		h.frames(2);
		h.canvas.dispatchEvent(new Event('webglcontextlost'));
		const drawn = h.draw.mock.calls.length;
		h.loop.requestRender();
		h.frames(30);
		expect(h.draw.mock.calls.length).toBe(drawn);
		expect(h.onContextLost).toHaveBeenCalledTimes(1);
		const view = resolveRoomView({
			channelType: ChannelTypes.GUILD_VOICE,
			rooms: true,
			theme: 'gece-lounge',
			isMobileLayout: false,
			webgl: {webgl2: true, renderer: 'ANGLE (NVIDIA)', hardwareConcurrency: 8, deviceMemory: 8},
			preferRoom: VoiceSceneSettings.preferRoom,
			contextLost: VoiceSceneSettings.failure === 'context_lost',
			loadFailed: VoiceSceneSettings.failure === 'load_failed',
		});
		expect(view).toEqual({show: false, reason: 'context_lost'});
		expect(voice.disconnect).not.toHaveBeenCalled();
		VoiceSceneSettings.retry();
		expect(VoiceSceneSettings.failure).toBeNull();
	});

	it('dispose cancels the pending frame and ignores later requests', () => {
		const h = harness(() => true);
		h.loop.requestRender();
		h.loop.dispose();
		h.loop.requestRender();
		h.frames(10);
		expect(h.draw).not.toHaveBeenCalled();
		expect(h.pendingFrames()).toBe(0);
	});
});
