// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const capture = vi.hoisted(() => ({
	context: {createMediaElementSource: vi.fn(), createGain: vi.fn()},
	master: {},
	active: true,
	activate: null as (() => void) | null,
}));

vi.mock('@app/features/notification/utils/SoundUtils', () => ({
	getSoundCaptureAudioContext: () => capture.context,
	getSoundCaptureMasterGainNode: () => capture.master,
	isSoundCaptureActive: () => capture.active,
	onSoundCaptureActivated: (callback: () => void) => {
		capture.activate = callback;
	},
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
	},
}));

class FakeMediaElement extends EventTarget {
	volume = 0.6;
	muted = false;
	readonly volumeListeners = new Set<EventListenerOrEventListenerObject>();

	override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
		if (type === 'volumechange' && listener) this.volumeListeners.add(listener);
		super.addEventListener(type, listener);
	}

	override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
		if (type === 'volumechange' && listener) this.volumeListeners.delete(listener);
		super.removeEventListener(type, listener);
	}
}

function createNode() {
	const outputs = new Set<object>();
	return {
		outputs,
		gain: {value: 1},
		connect: vi.fn((destination: object) => {
			outputs.add(destination);
			return destination;
		}),
		disconnect: vi.fn(() => outputs.clear()),
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	capture.active = true;
	capture.activate = null;
});

afterEach(() => vi.restoreAllMocks());

async function setup() {
	const sources = new WeakSet<object>();
	const source = createNode();
	const gains: Array<ReturnType<typeof createNode>> = [];
	capture.context.createMediaElementSource.mockImplementation((element: object) => {
		if (sources.has(element)) throw new Error('element already has a source');
		sources.add(element);
		return source;
	});
	capture.context.createGain.mockImplementation(() => {
		const gain = createNode();
		gains.push(gain);
		return gain;
	});
	const {routeMediaElementForSoundCapture} = await import('./InAppMediaSoundCapture');
	const element = new FakeMediaElement();
	const route = () => routeMediaElementForSoundCapture(element as unknown as HTMLMediaElement);
	return {source, gains, element, route};
}

describe('media element capture source ownership', () => {
	it.each(['gain creation', 'source connect', 'gain connect'])(
		'releases partial graph edges and reuses the element source after %s failure',
		async (failure) => {
			const {source, gains, element, route} = await setup();
			if (failure === 'gain creation') {
				capture.context.createGain.mockImplementationOnce(() => {
					throw new Error(failure);
				});
			} else if (failure === 'source connect') {
				source.connect.mockImplementationOnce((destination) => {
					source.outputs.add(destination);
					throw new Error(failure);
				});
			} else {
				const failedGain = createNode();
				gains.push(failedGain);
				failedGain.connect.mockImplementationOnce((destination) => {
					failedGain.outputs.add(destination);
					throw new Error(failure);
				});
				capture.context.createGain.mockReturnValueOnce(failedGain);
			}

			route()();

			expect(source.outputs.size).toBe(0);
			expect(gains.every((gain) => gain.outputs.size === 0)).toBe(true);
			expect(element.volumeListeners.size).toBe(0);

			const detach = route();

			expect(capture.context.createMediaElementSource).toHaveBeenCalledTimes(1);
			expect(source.outputs.size).toBe(1);
			expect(gains.filter((gain) => gain.outputs.has(capture.master))).toHaveLength(1);
			expect(element.volumeListeners.size).toBe(1);
			detach();
			detach();
			expect(gains.every((gain) => gain.outputs.size === 0)).toBe(true);
			expect(element.volumeListeners.size).toBe(0);
		},
	);

	it('keeps one source, one gain and one listener across healthy repeated routing', async () => {
		const {source, gains, element, route} = await setup();
		const firstDetach = route();
		const repeatedDetach = route();
		expect(element.volumeListeners.size).toBe(1);
		expect(gains[0].gain.value).toBe(0.6);
		element.muted = true;
		element.dispatchEvent(new Event('volumechange'));
		expect(gains[0].gain.value).toBe(0);
		firstDetach();
		repeatedDetach();
		expect(element.volumeListeners.size).toBe(0);
		expect(gains[0].outputs.size).toBe(0);

		element.muted = false;
		const detach = route();
		expect(capture.context.createMediaElementSource).toHaveBeenCalledTimes(1);
		expect(capture.context.createGain).toHaveBeenCalledTimes(1);
		expect(source.outputs.size).toBe(1);
		expect(gains[0].outputs.has(capture.master)).toBe(true);
		expect(gains[0].gain.value).toBe(0.6);
		expect(element.volumeListeners.size).toBe(1);
		detach();
		expect(element.volumeListeners.size).toBe(0);
		expect(gains[0].outputs.size).toBe(0);
	});

	it('does not create a graph for an inactive element detached before activation', async () => {
		capture.active = false;
		const {element, route} = await setup();
		route()();
		capture.active = true;
		capture.activate?.();
		expect(capture.context.createMediaElementSource).not.toHaveBeenCalled();
		expect(element.volumeListeners.size).toBe(0);
	});
});
