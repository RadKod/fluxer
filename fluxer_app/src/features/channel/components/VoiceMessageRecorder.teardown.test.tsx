// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import VoiceMessageRecorder from '@app/features/channel/components/VoiceMessageRecorder';
import {sendVoiceMessage} from '@app/features/voice/utils/VoiceMessageSendUtils';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (value: unknown) => value}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (value: {message: string}) => value.message, locale: 'en'}}),
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: true}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1200}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		error() {}
	},
}));
vi.mock('@app/features/ui/overlay/PortalHostContext', () => ({usePortalHost: () => null}));
vi.mock('@app/features/ui/utils/ReducedMotionAnimation', () => ({getReducedMotionProps: () => ({})}));
vi.mock('@app/features/voice/utils/VoiceMessageRecordingUtils', () => ({
	computeVoiceWaveformFromAudioBuffer: () => ({duration: 1, waveform: []}),
	prepareVoiceMessageWav: vi.fn(),
}));
vi.mock('@app/features/voice/utils/VoiceMessageSendUtils', () => ({sendVoiceMessage: vi.fn()}));
vi.mock('@floating-ui/react', () => ({
	autoUpdate: vi.fn(),
	flip: vi.fn(),
	offset: vi.fn(),
	shift: vi.fn(),
	FloatingPortal: ({children}: {children: ReactNode}) => children,
	useFloating: () => ({refs: {setReference: vi.fn(), setFloating: vi.fn()}, floatingStyles: {}, isPositioned: false}),
}));
vi.mock('framer-motion', () => ({
	AnimatePresence: ({children}: {children: ReactNode}) => children,
	motion: {
		button: ({animate: _animate, transition: _transition, ...props}: Record<string, unknown>) =>
			createElement('button', {...props, type: 'button'}),
		div: ({
			initial: _initial,
			animate: _animate,
			exit: _exit,
			transition: _transition,
			...props
		}: Record<string, unknown>) => createElement('div', props),
	},
}));

let host: HTMLDivElement;
let root: Root | null;
let failure: 'source' | 'analyser' | 'connect' | null;
let tracks: Set<object>;
let contexts: Set<object>;
let sources: Set<object>;
let recorders: Set<object>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let getUserMedia: ReturnType<typeof vi.fn>;
let deferRecorderStop: boolean;
let nextRecorderChunk: Blob | null;
let creations: {contexts: number; sources: number; recorders: number};

function stream(): MediaStream {
	const track = {stop: () => tracks.delete(track)};
	tracks.add(track);
	return {getTracks: () => [track]} as unknown as MediaStream;
}

function counts() {
	return {
		tracks: tracks.size,
		contexts: contexts.size,
		sources: sources.size,
		recorders: recorders.size,
		frames: frames.size,
	};
}

async function unmount() {
	await act(async () => root?.unmount());
	root = null;
}

async function start() {
	const button = host.querySelector('button')!;
	button.setPointerCapture = vi.fn();
	await act(async () => {
		button.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerId: 1}));
	});
}

async function cancelPending(action: 'pointercancel' | 'pointerup' | 'escape' | 'hidden' | 'disabled') {
	await act(async () => {
		if (action === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
		else if (action === 'hidden') {
			vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
			document.dispatchEvent(new Event('visibilitychange'));
		} else if (action === 'disabled') {
			root?.render(createElement(VoiceMessageRecorder, {channelId: '1', disabled: true}));
		} else {
			host
				.querySelector('button')!
				.dispatchEvent(new PointerEvent(action, {bubbles: true, pointerId: 1, clientX: 200, clientY: 200}));
		}
	});
}

beforeEach(async () => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	failure = null;
	deferRecorderStop = false;
	nextRecorderChunk = null;
	creations = {contexts: 0, sources: 0, recorders: 0};
	vi.mocked(sendVoiceMessage).mockClear();
	tracks = new Set();
	contexts = new Set();
	sources = new Set();
	recorders = new Set();
	frames = new Map();
	nextFrame = 0;
	getUserMedia = vi.fn();
	vi.stubGlobal('navigator', {mediaDevices: {getUserMedia}});
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
	vi.stubGlobal(
		'AudioContext',
		class {
			ownedSources = new Set<object>();
			constructor() {
				creations.contexts++;
				contexts.add(this);
			}
			createMediaStreamSource() {
				creations.sources++;
				if (failure === 'source') throw new Error('source failed');
				const source = {
					connect: () => {
						if (failure === 'connect') throw new Error('connect failed');
					},
					disconnect: () => sources.delete(source),
				};
				sources.add(source);
				this.ownedSources.add(source);
				return source;
			}
			createAnalyser() {
				if (failure === 'analyser') throw new Error('analyser failed');
				return {
					frequencyBinCount: 128,
					disconnect: vi.fn(),
					getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
				};
			}
			async close() {
				contexts.delete(this);
				for (const source of this.ownedSources) sources.delete(source);
			}
			async decodeAudioData() {
				return {};
			}
		},
	);
	vi.stubGlobal(
		'MediaRecorder',
		class extends EventTarget {
			constructor() {
				super();
				creations.recorders++;
			}
			static isTypeSupported() {
				return true;
			}
			state = 'inactive';
			mimeType = 'audio/mp4';
			finalChunk = nextRecorderChunk;
			start() {
				this.state = 'recording';
				recorders.add(this);
			}
			stop() {
				this.state = 'inactive';
				recorders.delete(this);
				const dispatchFinalEvents = () => {
					if (this.finalChunk) {
						const event = new Event('dataavailable');
						Object.defineProperty(event, 'data', {value: this.finalChunk});
						this.dispatchEvent(event);
					}
					this.dispatchEvent(new Event('stop'));
				};
				if (deferRecorderStop) window.setTimeout(dispatchFinalEvents, 0);
				else dispatchFinalEvents();
			}
		},
	);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root?.render(createElement(VoiceMessageRecorder, {channelId: '1', disabled: false})));
});

afterEach(async () => {
	await unmount();
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('VoiceMessageRecorder resource teardown', () => {
	it.each(['pointercancel', 'pointerup', 'escape', 'hidden', 'disabled'] as const)(
		'stops late permission after %s without installing any recording resources',
		async (action) => {
			let resolve!: (value: MediaStream) => void;
			getUserMedia.mockReturnValue(new Promise<MediaStream>((done) => (resolve = done)));
			await start();
			await cancelPending(action);
			await act(async () => resolve(stream()));
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
			expect(creations).toEqual({contexts: 0, sources: 0, recorders: 0});
			expect(vi.getTimerCount()).toBe(0);
			expect(sendVoiceMessage).not.toHaveBeenCalled();
		},
	);

	it.each(['resolve', 'reject'] as const)(
		'keeps a fresh recording when canceled permission later %ss',
		async (result) => {
			let resolve!: (value: MediaStream) => void;
			let reject!: (reason: Error) => void;
			getUserMedia.mockReturnValueOnce(
				new Promise<MediaStream>((done, fail) => {
					resolve = done;
					reject = fail;
				}),
			);
			await start();
			await cancelPending('pointercancel');
			getUserMedia.mockResolvedValueOnce(stream());
			await start();
			expect(getUserMedia).toHaveBeenCalledTimes(2);
			expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
			await act(async () => {
				if (result === 'resolve') resolve(stream());
				else reject(new Error('canceled permission denied'));
			});
			expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
			expect(creations).toEqual({contexts: 1, sources: 1, recorders: 1});
			expect(vi.getTimerCount()).toBe(2);
			await unmount();
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		},
	);

	it('does not unlock a fresh pending permission request when the canceled request resolves', async () => {
		const resolves: Array<(value: MediaStream) => void> = [];
		getUserMedia.mockImplementation(() => new Promise<MediaStream>((done) => resolves.push(done)));
		await start();
		await cancelPending('pointerup');
		await start();
		expect(getUserMedia).toHaveBeenCalledTimes(2);
		await act(async () => resolves[0](stream()));
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		await start();
		expect(getUserMedia).toHaveBeenCalledTimes(2);
		await act(async () => resolves[1](stream()));
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
	});

	it.each(['pointercancel', 'pointerup'] as const)('still discards a short active gesture on %s', async (action) => {
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		await cancelPending(action);
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(sendVoiceMessage).not.toHaveBeenCalled();
	});

	it.each(['pointercancel', 'pointerup'] as const)('still sends a long active gesture on %s', async (action) => {
		let now = 100;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		nextRecorderChunk = new Blob(['VOICE']);
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		now = 1000;
		await cancelPending(action);
		expect(sendVoiceMessage).toHaveBeenCalledTimes(1);
		const {file} = vi.mocked(sendVoiceMessage).mock.calls[0][0];
		expect(await file.text()).toBe('VOICE');
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
	});

	it('keeps a gesture locked after releasing over the lock threshold', async () => {
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		await act(async () => {
			host
				.querySelector('button')!
				.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 1, clientX: 0, clientY: -100}));
		});
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		await cancelPending('pointercancel');
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Discard voice message"]')!.click());
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
	});

	it('sends only the retry recording when an old recorder queues final data before its stop event', async () => {
		let now = 100;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		deferRecorderStop = true;
		failure = 'connect';
		nextRecorderChunk = new Blob(['OLD']);
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		failure = null;
		nextRecorderChunk = new Blob(['FRESH']);
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		await act(async () => vi.advanceTimersByTime(0));
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		now = 1000;
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send voice message"]')!.click());
		await act(async () => vi.advanceTimersByTime(0));
		expect(sendVoiceMessage).toHaveBeenCalledTimes(1);
		const {file} = vi.mocked(sendVoiceMessage).mock.calls[0][0];
		expect(await file.text()).toBe('FRESH');
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
	});

	it('keeps one healthy recording across repeated pointerdowns while microphone permission is pending', async () => {
		const resolves: Array<(value: MediaStream) => void> = [];
		const rejects: Array<(reason: Error) => void> = [];
		getUserMedia.mockImplementation(
			() =>
				new Promise<MediaStream>((done, fail) => {
					resolves.push(done);
					rejects.push(fail);
				}),
		);
		await start();
		await start();
		await act(async () => resolves[0](stream()));
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		if (rejects.length > 1) await act(async () => rejects[1](new Error('second permission denied')));
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		await unmount();
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
	});

	it('allows a fresh permission request after the previous request rejects', async () => {
		getUserMedia.mockRejectedValueOnce(new Error('permission denied'));
		await start();
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		expect(getUserMedia).toHaveBeenCalledTimes(2);
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
	});

	it('ignores a queued stop from failed waveform setup after a healthy retry starts', async () => {
		deferRecorderStop = true;
		failure = 'connect';
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		failure = null;
		getUserMedia.mockResolvedValueOnce(stream());
		await start();
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		await act(async () => vi.advanceTimersByTime(0));
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		deferRecorderStop = false;
		await unmount();
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not leave an error tooltip timer after permission rejects on an unmounted component', async () => {
		let reject!: (reason: Error) => void;
		getUserMedia.mockReturnValue(
			new Promise<MediaStream>((_resolve, fail) => {
				reject = fail;
			}),
		);
		await start();
		await unmount();
		await act(async () => reject(new Error('permission denied')));
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(vi.getTimerCount()).toBe(0);
	});
	it('stops late microphone permission results after unmount without creating recording resources', async () => {
		let resolve!: (value: MediaStream) => void;
		getUserMedia.mockReturnValue(
			new Promise<MediaStream>((done) => {
				resolve = done;
			}),
		);
		await start();
		await unmount();
		await act(async () => resolve(stream()));
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(creations).toEqual({contexts: 0, sources: 0, recorders: 0});
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['source', 'analyser', 'connect'] as const)(
		'returns all recording resources when waveform %s setup fails',
		async (point) => {
			failure = point;
			getUserMedia.mockResolvedValue(stream());
			await start();
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
			// Only the bounded error tooltip may remain; the recording interval must be gone.
			expect(vi.getTimerCount()).toBe(1);
			await unmount();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(['unmount', 'discard'] as const)(
		'keeps a healthy recording active until %s and then releases it',
		async (action) => {
			getUserMedia.mockResolvedValue(stream());
			await start();
			expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
			expect(vi.getTimerCount()).toBe(2);
			if (action === 'discard') {
				await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Discard voice message"]')!.click());
			} else await unmount();
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
			await unmount();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
