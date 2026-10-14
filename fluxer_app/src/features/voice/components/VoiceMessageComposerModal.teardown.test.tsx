// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {showGenericErrorModal} from '@app/features/app/components/alerts/GenericErrorModalCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {VoiceMessageComposerModal} from '@app/features/voice/components/VoiceMessageComposerModal';
import {encodeAudioBufferSliceToWav} from '@app/features/voice/utils/AudioWavEncode';
import {computeVoiceWaveformFromAudioBuffer} from '@app/features/voice/utils/VoiceMessageRecordingUtils';
import {sendVoiceMessage} from '@app/features/voice/utils/VoiceMessageSendUtils';
import {act, createElement, type ReactNode, StrictMode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = vi.hoisted(() => ({_: (value: {message: string}) => value.message, locale: 'en'}));
vi.mock('@lingui/core/macro', () => ({msg: (value: unknown) => value}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/components/alerts/GenericErrorModalCommands', () => ({showGenericErrorModal: vi.fn()}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: ({children}: {children: ReactNode}) => children,
	Header: () => null,
	Content: ({children}: {children: ReactNode}) => children,
	Footer: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({
	CANCEL_DESCRIPTOR: {message: 'Cancel'},
	PAUSE_DESCRIPTOR: {message: 'Pause'},
	SOMETHING_WENT_WRONG_DESCRIPTOR: {message: 'Error'},
}));
vi.mock('@app/features/i18n/utils/IntlCache', () => ({getCachedNumberFormat: () => new Intl.NumberFormat('en')}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
	},
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, ...props}: {children: ReactNode; onClick: () => void; 'data-flx': string}) =>
		createElement('button', {type: 'button', onClick, 'data-flx': props['data-flx']}, children),
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({popByType: vi.fn()}));
vi.mock('@app/features/voice/components/AudioWaveform', () => ({AudioWaveform: () => null, computePeaks: () => []}));
vi.mock('@app/features/voice/components/LiveRecordingWaveform', () => ({LiveRecordingWaveform: () => null}));
vi.mock('@app/features/voice/utils/AudioWavEncode', () => ({encodeAudioBufferSliceToWav: vi.fn()}));
vi.mock('@app/features/voice/utils/VoiceMessageRecordingUtils', () => ({computeVoiceWaveformFromAudioBuffer: vi.fn()}));
vi.mock('@app/features/voice/utils/VoiceMessageSendUtils', () => ({sendVoiceMessage: vi.fn()}));

let host: HTMLDivElement;
let root: Root | null;
let tracks: Set<object>;
let contexts: Set<object>;
let sources: Set<object>;
let recorders: Set<object>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let getUserMedia: ReturnType<typeof vi.fn>;
let recorderInstances: Array<{
	ondataavailable: ((event: {data: Blob}) => void) | null;
	onstop: (() => void) | null;
	onerror: ((event: Event) => void) | null;
}>;
let delayRecorderStop: boolean;
let decodeAudioData: ReturnType<typeof vi.fn>;
let playbackStart: ReturnType<typeof vi.fn>;
let decodedAudio: AudioBuffer;

async function click(action: string) {
	await act(async () =>
		host.querySelector<HTMLButtonElement>(`[data-flx="voice.voice-message-composer-modal.${action}-button"]`)!.click(),
	);
}

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

async function mount(strict = false) {
	await act(async () => {
		const component = createElement(VoiceMessageComposerModal, {channelId: '1'});
		root?.render(strict ? createElement(StrictMode, null, component) : component);
	});
}

async function unmount() {
	await act(async () => root?.unmount());
	root = null;
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.clearAllMocks();
	tracks = new Set();
	contexts = new Set();
	sources = new Set();
	recorders = new Set();
	frames = new Map();
	nextFrame = 0;
	recorderInstances = [];
	delayRecorderStop = false;
	decodedAudio = {duration: 2} as AudioBuffer;
	decodeAudioData = vi.fn().mockResolvedValue(decodedAudio);
	playbackStart = vi.fn();
	vi.mocked(encodeAudioBufferSliceToWav).mockReturnValue(new Blob(['wav'], {type: 'audio/wav'}));
	vi.mocked(computeVoiceWaveformFromAudioBuffer).mockReturnValue({duration: 2, waveform: 'waveform'});
	vi.mocked(sendVoiceMessage).mockResolvedValue(undefined);
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
			currentTime = 0;
			destination = {};
			decodeAudioData = decodeAudioData;
			constructor() {
				contexts.add(this);
			}
			createMediaStreamSource() {
				const source = {connect: vi.fn(), disconnect: () => sources.delete(source)};
				sources.add(source);
				this.ownedSources.add(source);
				return source;
			}
			createAnalyser() {
				return {fftSize: 1024, disconnect: vi.fn(), getByteTimeDomainData: (data: Uint8Array) => data.fill(128)};
			}
			createBufferSource() {
				const source = {
					buffer: null,
					onended: null,
					connect: vi.fn(),
					start: playbackStart,
					stop: vi.fn(),
					disconnect: () => sources.delete(source),
				};
				sources.add(source);
				this.ownedSources.add(source);
				return source;
			}
			async close() {
				contexts.delete(this);
				for (const source of this.ownedSources) sources.delete(source);
			}
		},
	);
	vi.stubGlobal(
		'MediaRecorder',
		class {
			static isTypeSupported() {
				return true;
			}
			state = 'inactive';
			onstop: (() => void) | null = null;
			ondataavailable: ((event: {data: Blob}) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			constructor() {
				recorderInstances.push(this);
			}
			start() {
				this.state = 'recording';
				recorders.add(this);
			}
			stop() {
				this.state = 'inactive';
				recorders.delete(this);
				if (!delayRecorderStop) this.onstop?.();
			}
		},
	);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await unmount();
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('VoiceMessageComposerModal resource teardown', () => {
	it('returns a late permission stream when close requests a pop before the modal unmounts', async () => {
		let resolve!: (value: MediaStream) => void;
		getUserMedia.mockReturnValue(
			new Promise<MediaStream>((done) => {
				resolve = done;
			}),
		);
		await mount();
		await act(async () =>
			host.querySelector<HTMLButtonElement>('[data-flx="voice.voice-message-composer-modal.cancel-button"]')!.click(),
		);
		await act(async () => resolve(stream()));
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(vi.getTimerCount()).toBe(0);
	});
	it('returns a late permission stream after unmount without opening recording resources', async () => {
		let resolve!: (value: MediaStream) => void;
		getUserMedia.mockReturnValue(
			new Promise<MediaStream>((done) => {
				resolve = done;
			}),
		);
		await mount();
		await unmount();
		await act(async () => resolve(stream()));
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['resolve', 'reject'] as const)(
		'keeps a healthy StrictMode recording when the superseded permission request later %ss',
		async (completion) => {
			const resolves: Array<(value: MediaStream) => void> = [];
			const rejects: Array<(reason: Error) => void> = [];
			getUserMedia.mockImplementation(
				() =>
					new Promise<MediaStream>((done, fail) => {
						resolves.push(done);
						rejects.push(fail);
					}),
			);
			await mount(true);
			expect(getUserMedia).toHaveBeenCalledTimes(2);
			await act(async () => resolves[1](stream()));
			expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
			await act(async () => {
				if (completion === 'resolve') resolves[0](stream());
				else rejects[0](new Error('old permission denied'));
			});
			expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
			await unmount();
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		},
	);

	it.each(['unmount', 'stop'] as const)(
		'keeps healthy recording active until %s and releases capture resources',
		async (action) => {
			getUserMedia.mockResolvedValue(stream());
			await mount();
			expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
			if (action === 'stop') {
				await act(async () =>
					host.querySelector<HTMLButtonElement>('[data-flx="voice.voice-message-composer-modal.stop-button"]')!.click(),
				);
			} else await unmount();
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('decodes a successful recording, plays its selection and sends the WAV', async () => {
		getUserMedia.mockResolvedValue(stream());
		await mount();
		await act(async () => recorderInstances[0].ondataavailable?.({data: new Blob(['recorded audio'])}));
		await click('stop');
		expect(decodeAudioData).toHaveBeenCalledOnce();
		expect(new TextDecoder().decode(decodeAudioData.mock.calls[0][0])).toBe('recorded audio');
		expect(counts()).toEqual({tracks: 0, contexts: 1, sources: 0, recorders: 0, frames: 0});
		await click('play');
		expect(playbackStart).toHaveBeenCalledWith(0, 0, 2);
		expect(counts()).toEqual({tracks: 0, contexts: 1, sources: 1, recorders: 0, frames: 1});
		await click('play');
		expect(counts()).toEqual({tracks: 0, contexts: 1, sources: 0, recorders: 0, frames: 0});
		await click('send');
		expect(encodeAudioBufferSliceToWav).toHaveBeenCalledWith(decodedAudio, {
			startSeconds: 0,
			endSeconds: 2,
			downmixToMono: true,
		});
		expect(sendVoiceMessage).toHaveBeenCalledWith({
			channelId: '1',
			file: expect.any(File),
			waveform: 'waveform',
			duration: 2,
			title: 'voice-message.wav',
		});
		const file = vi.mocked(sendVoiceMessage).mock.calls[0][0].file;
		expect(file.type).toBe('audio/wav');
		expect(await file.text()).toBe('wav');
		expect(ModalCommands.popByType).toHaveBeenCalledWith(VoiceMessageComposerModal);
		expect(showGenericErrorModal).not.toHaveBeenCalled();
		await unmount();
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
	});

	it('releases recording resources and offers retry when the recorder fails before Stop', async () => {
		getUserMedia.mockResolvedValue(stream());
		await mount();
		await act(async () => recorderInstances[0].onerror?.(new Event('error')));
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(host.querySelector('[data-flx="voice.voice-message-composer-modal.permission-error"]')?.textContent).toBe(
			'Recording failed. Try again.',
		);
		expect(host.querySelector('[data-flx="voice.voice-message-composer-modal.stop-button"]')).toBeNull();
		expect(host.querySelector('[data-flx="voice.voice-message-composer-modal.retry-button"]')).not.toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('ignores stale recorder errors after retry starts a newer recording', async () => {
		getUserMedia.mockImplementation(async () => stream());
		await mount();
		const oldRecorder = recorderInstances[0];
		await act(async () => oldRecorder.onerror?.(new Event('error')));
		await click('retry');
		await act(async () => oldRecorder.onerror?.(new Event('error')));
		expect(counts()).toEqual({tracks: 1, contexts: 1, sources: 1, recorders: 1, frames: 1});
		expect(host.querySelector('[data-flx="voice.voice-message-composer-modal.permission-error"]')).toBeNull();
		await act(async () => recorderInstances[1].ondataavailable?.({data: new Blob(['fresh audio'])}));
		await click('stop');
		expect(new TextDecoder().decode(decodeAudioData.mock.calls[0][0])).toBe('fresh audio');
		expect(showGenericErrorModal).not.toHaveBeenCalled();
		await unmount();
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
	});

	it('ignores stale recorder data after a successful review starts a newer recording', async () => {
		getUserMedia.mockImplementation(async () => stream());
		await mount();
		const oldRecorder = recorderInstances[0];
		await act(async () => oldRecorder.ondataavailable?.({data: new Blob(['first recording'])}));
		await click('stop');
		expect(decodeAudioData).toHaveBeenCalledOnce();
		await click('redo');
		decodeAudioData.mockClear();
		expect(counts()).toEqual({tracks: 1, contexts: 2, sources: 1, recorders: 1, frames: 1});
		await act(async () => recorderInstances[1].ondataavailable?.({data: new Blob(['fresh audio'])}));
		delayRecorderStop = true;
		await click('stop');
		await act(async () => {
			oldRecorder.ondataavailable?.({data: new Blob(['old audio'])});
			oldRecorder.onstop?.();
			recorderInstances[1].onstop?.();
		});
		expect(new TextDecoder().decode(decodeAudioData.mock.calls[0][0])).toBe('fresh audio');
		expect(showGenericErrorModal).not.toHaveBeenCalled();
		await unmount();
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
	});

	it('does not open a decode context when delayed recording data arrives after Stop and unmount', async () => {
		delayRecorderStop = true;
		getUserMedia.mockResolvedValue(stream());
		await mount();
		const recorder = recorderInstances[0];
		await click('stop');
		await unmount();
		await act(async () => {
			recorder.ondataavailable?.({data: new Blob(['late audio'])});
			recorder.onstop?.();
		});
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(decodeAudioData).not.toHaveBeenCalled();
		expect(showGenericErrorModal).not.toHaveBeenCalled();
	});

	it('does not decode when reading recorded bytes finishes after unmount', async () => {
		let resolve!: (value: ArrayBuffer) => void;
		const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer').mockReturnValueOnce(
			new Promise<ArrayBuffer>((done) => {
				resolve = done;
			}),
		);
		try {
			getUserMedia.mockResolvedValue(stream());
			await mount();
			await act(async () => recorderInstances[0].ondataavailable?.({data: new Blob(['audio'])}));
			await click('stop');
			await unmount();
			await act(async () => resolve(new ArrayBuffer(4)));
			expect(decodeAudioData).not.toHaveBeenCalled();
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
			expect(showGenericErrorModal).not.toHaveBeenCalled();
		} finally {
			arrayBuffer.mockRestore();
		}
	});

	it('does not create a decode context when unmount happens before the Stop continuation runs', async () => {
		getUserMedia.mockResolvedValue(stream());
		await mount();
		await act(async () => recorderInstances[0].ondataavailable?.({data: new Blob(['audio'])}));
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-flx="voice.voice-message-composer-modal.stop-button"]')!.click();
			root?.unmount();
			root = null;
		});
		expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		expect(decodeAudioData).not.toHaveBeenCalled();
		expect(showGenericErrorModal).not.toHaveBeenCalled();
	});

	it.each(['resolve', 'reject'] as const)(
		'ignores a decode that later %ss after close requests a pop',
		async (completion) => {
			let resolve!: (value: AudioBuffer) => void;
			let reject!: (error: Error) => void;
			decodeAudioData.mockReturnValueOnce(
				new Promise<AudioBuffer>((done, fail) => {
					resolve = done;
					reject = fail;
				}),
			);
			getUserMedia.mockResolvedValue(stream());
			await mount();
			await act(async () => recorderInstances[0].ondataavailable?.({data: new Blob(['audio'])}));
			await click('stop');
			expect(decodeAudioData).toHaveBeenCalledOnce();
			await click('cancel');
			await act(async () => {
				if (completion === 'resolve') resolve(decodedAudio);
				else reject(new Error('old decode failed'));
			});
			expect(host.querySelector('[data-flx="voice.voice-message-composer-modal.send-button"]')).toBeNull();
			expect(showGenericErrorModal).not.toHaveBeenCalled();
			await unmount();
			expect(counts()).toEqual({tracks: 0, contexts: 0, sources: 0, recorders: 0, frames: 0});
		},
	);
});
