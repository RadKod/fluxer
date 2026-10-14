// SPDX-License-Identifier: AGPL-3.0-or-later

import {createVoiceSoftClipNode} from '@app/features/voice/engine/VoiceSharedAudioContext';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function fakeContext(): BaseAudioContext {
	return {
		createGain: () => ({gain: {value: 1}, connect: vi.fn()}),
		createWaveShaper: () => ({curve: null, oversample: 'none', connect: vi.fn()}),
	} as unknown as BaseAudioContext;
}

describe('createVoiceSoftClipNode', () => {
	it('soft clip oversamples 4x', () => {
		const node = createVoiceSoftClipNode(fakeContext());
		expect(node).not.toBeNull();
		expect(node!.output.oversample).toBe('4x');
	});
});

class FakeVoiceAudioContext extends EventTarget {
	static created: Array<FakeVoiceAudioContext> = [];
	state: 'running' | 'suspended' | 'closed' = 'running';
	readonly destination = {};
	readonly suspend = vi.fn(async () => {
		this.state = 'suspended';
	});
	readonly resume = vi.fn(async () => {
		this.state = 'running';
	});
	constructor() {
		super();
		FakeVoiceAudioContext.created.push(this);
	}
	createGain() {
		return {gain: {value: 1}, connect: vi.fn()};
	}
	createWaveShaper() {
		return {curve: null, oversample: 'none', connect: vi.fn()};
	}
}

describe('shared voice AudioContext between calls', () => {
	let shared: typeof import('@app/features/voice/engine/VoiceSharedAudioContext');

	beforeEach(async () => {
		vi.resetModules();
		FakeVoiceAudioContext.created.length = 0;
		vi.stubGlobal('window', {AudioContext: FakeVoiceAudioContext});
		shared = await import('@app/features/voice/engine/VoiceSharedAudioContext');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('suspends the context when the call ends', () => {
		const context = shared.getSharedVoiceAudioContext() as unknown as FakeVoiceAudioContext;
		shared.suspendSharedVoiceAudioContext();
		expect(context.suspend).toHaveBeenCalledTimes(1);
		expect(context.state).toBe('suspended');
	});

	it('the next call gets the same context running again', () => {
		const context = shared.getSharedVoiceAudioContext() as unknown as FakeVoiceAudioContext;
		shared.suspendSharedVoiceAudioContext();
		const next = shared.getSharedVoiceAudioContext() as unknown as FakeVoiceAudioContext;
		expect(next).toBe(context);
		expect(context.resume).toHaveBeenCalledTimes(1);
		expect(context.state).toBe('running');
		expect(FakeVoiceAudioContext.created).toHaveLength(1);
	});

	it('a resume after the call ended is undone until the next call', () => {
		const context = shared.getSharedVoiceAudioContext() as unknown as FakeVoiceAudioContext;
		shared.suspendSharedVoiceAudioContext();
		context.state = 'running';
		context.dispatchEvent(new Event('statechange'));
		expect(context.suspend).toHaveBeenCalledTimes(2);
		expect(context.state).toBe('suspended');
	});

	it('the next call keeps the context running', () => {
		const context = shared.getSharedVoiceAudioContext() as unknown as FakeVoiceAudioContext;
		shared.suspendSharedVoiceAudioContext();
		shared.getSharedVoiceAudioContext();
		context.dispatchEvent(new Event('statechange'));
		expect(context.suspend).toHaveBeenCalledTimes(1);
		expect(context.state).toBe('running');
	});

	it('does not create a context only to suspend it', () => {
		shared.suspendSharedVoiceAudioContext();
		expect(FakeVoiceAudioContext.created).toHaveLength(0);
	});
});
