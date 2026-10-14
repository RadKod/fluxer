// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, expect, it, vi} from 'vitest';

class FakeAudioContext extends EventTarget {
	static instances: Array<FakeAudioContext> = [];
	readonly calls: Array<string> = [];
	readonly sampleRate = 48000;
	readonly destination = {};
	state: AudioContextState = 'running';
	constructor() {
		super();
		FakeAudioContext.instances.push(this);
	}
	private setState(state: AudioContextState): void {
		this.state = state;
		this.dispatchEvent(new Event('statechange'));
	}
	async suspend(): Promise<void> {
		this.calls.push('suspend');
		this.setState('suspended');
	}
	async resume(): Promise<void> {
		this.calls.push('resume');
		this.setState('running');
	}
	createMediaStreamSource(): object {
		return {};
	}
	async close(): Promise<void> {
		this.calls.push(`close:${this.state}`);
		this.setState('closed');
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.resetModules();
	FakeAudioContext.instances = [];
});

// Chromium keeps an AudioWorkletNode and its context alive after close() until the processor's process() has
// returned false. Nodes disposed while the idle context is suspended must render once before it is closed.
it('lets disposed worklet processors render before an idle input context is closed', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', Object.assign(new EventTarget(), {AudioContext: FakeAudioContext}));
	const {acquireVoiceInputContext} = await import('./VoiceInputAudioContext');
	const lease = acquireVoiceInputContext();
	const context = FakeAudioContext.instances[0];
	expect(lease?.context).toBe(context);
	lease?.release();
	await vi.advanceTimersByTimeAsync(500);
	expect(context.state).toBe('suspended');
	await vi.advanceTimersByTimeAsync(60_000);
	expect(context.calls).toEqual(['suspend', 'resume']);
	await vi.advanceTimersByTimeAsync(100);
	expect(context.calls).toEqual(['suspend', 'resume', 'close:running']);
});

it('keeps a discarded input context on the idle path instead of closing it under its disposed nodes', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', Object.assign(new EventTarget(), {AudioContext: FakeAudioContext}));
	const {acquireVoiceInputContext, discardVoiceInputContext} = await import('./VoiceInputAudioContext');
	const lease = acquireVoiceInputContext();
	const context = FakeAudioContext.instances.at(-1)!;
	lease?.release();
	discardVoiceInputContext(context as unknown as AudioContext);
	const next = acquireVoiceInputContext();
	expect(next?.context).not.toBe(context);
	next?.release();
	await vi.advanceTimersByTimeAsync(100);
	expect(context.calls).toEqual([]);
	await vi.advanceTimersByTimeAsync(60_500);
	expect(context.calls).toEqual(['suspend', 'resume', 'close:running']);
});

// A worklet node released together with its context (the mic test during a call uses an unshared context) is
// disposed by its pool 60 s later. The context must still be open then, or the node and context outlive close().
it('keeps an unshared input context open until nodes idle-disposed on it have rendered', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', Object.assign(new EventTarget(), {AudioContext: FakeAudioContext}));
	vi.stubGlobal('MediaStream', class {});
	const {acquireVoiceInputSource, acquireIdleVoiceInputSource} = await import('./VoiceInputAudioContext');
	const track = {getSettings: () => ({})} as unknown as MediaStreamTrack;
	const shared = acquireVoiceInputSource(track);
	const unshared = acquireIdleVoiceInputSource(track);
	const context = unshared?.lease.context as unknown as FakeAudioContext;
	expect(context).not.toBe(shared?.lease.context);
	setTimeout(() => context.calls.push(`node-dispose:${context.state}`), 60_000);
	unshared?.lease.release();
	await vi.advanceTimersByTimeAsync(62_000);
	expect(context.calls).toEqual(['suspend', 'node-dispose:suspended', 'resume', 'close:running']);
	shared?.lease.release();
});

it('waits for a slow resume, such as a waking Bluetooth output, before closing', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', Object.assign(new EventTarget(), {AudioContext: FakeAudioContext}));
	const {acquireVoiceInputContext} = await import('./VoiceInputAudioContext');
	const lease = acquireVoiceInputContext();
	const context = FakeAudioContext.instances.at(-1)!;
	const resume = context.resume.bind(context);
	context.resume = () => new Promise<void>((resolve) => setTimeout(() => resume().then(resolve), 600));
	lease?.release();
	await vi.advanceTimersByTimeAsync(60_500);
	await vi.advanceTimersByTimeAsync(500);
	expect(context.calls).toEqual(['suspend']);
	await vi.advanceTimersByTimeAsync(200);
	expect(context.calls).toEqual(['suspend', 'resume', 'close:running']);
});

it('still closes a context whose resume() never settles, such as one that was never allowed to start', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', Object.assign(new EventTarget(), {AudioContext: FakeAudioContext}));
	const {acquireVoiceInputContext} = await import('./VoiceInputAudioContext');
	const lease = acquireVoiceInputContext();
	const context = FakeAudioContext.instances.at(-1)!;
	context.resume = () => {
		context.calls.push('resume');
		return new Promise<void>(() => {});
	};
	lease?.release();
	await vi.advanceTimersByTimeAsync(60_500);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(context.calls).toEqual(['suspend', 'resume']);
	await vi.advanceTimersByTimeAsync(100);
	expect(context.calls).toEqual(['suspend', 'resume', 'close:suspended']);
});
