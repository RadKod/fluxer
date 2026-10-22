// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/voice/engine/VoiceMediaEngineBridge', () => ({
	getRoomFromMediaEngine: () => null,
	setVoiceEngineV2ParticipantAudioLevelSpeaking: vi.fn(),
}));
vi.mock('@app/features/voice/state/ParticipantVolume', () => ({default: {applySettingsToParticipant: vi.fn()}}));
const boost = vi.hoisted(() => ({
	exempt: false,
	clear: vi.fn(),
	set: vi.fn(),
}));
vi.mock('@app/features/voice/state/RemoteVoicePlaybackBoost', () => ({
	clearRemoteVoicePlaybackBoost: boost.clear,
	setRemoteVoicePlaybackBoost: boost.set,
	isRemoteVoicePlaybackBoostExempt: () => boost.exempt,
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: {getVadThreshold: () => -60}}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	readVoicePipelineV2Enabled: () => false,
}));

class FakeNode {
	constructor(readonly context: FakeAudioContext) {}
	readonly connect = vi.fn();
	readonly disconnect = vi.fn();
	fftSize = 2048;
	smoothingTimeConstant = 0.8;
	getFloatTimeDomainData(samples: Float32Array): void {
		samples.fill(signalLevel);
	}
}

let signalLevel = 0;

class FakeAudioContext {
	state = 'running';
	readonly sources: Array<FakeNode> = [];
	readonly createMediaStreamSource = vi.fn(() => {
		const node = new FakeNode(this);
		this.sources.push(node);
		return node;
	});
	readonly createAnalyser = vi.fn(() => new FakeNode(this));
}

let context: FakeAudioContext;
vi.mock('@app/features/voice/engine/VoiceSharedAudioContext', () => ({
	getSharedVoiceAudioContext: () => context,
}));

const {VoiceEngineV2AppRemoteSpeakingAdapter} = await import(
	'@app/features/voice/engine/v2/VoiceEngineV2AppRemoteSpeakingAdapter'
);

interface FakeMediaStreamTrack {
	readyState: 'live' | 'ended';
}

function fakeTrack(): {kind: 'audio'; mediaStreamTrack: FakeMediaStreamTrack} {
	return {kind: 'audio', mediaStreamTrack: {readyState: 'live'}};
}

const participant = {identity: 'user_1_conn', isLocal: false};

function fakePublication(track: ReturnType<typeof fakeTrack>) {
	return {source: 'microphone', isSubscribed: true, track};
}

type Adapter = InstanceType<typeof VoiceEngineV2AppRemoteSpeakingAdapter>;
type AttachArgs = Parameters<Adapter['attachIfApplicable']>;

function attach(adapter: Adapter, publication: ReturnType<typeof fakePublication>): void {
	adapter.attachIfApplicable(
		participant as unknown as AttachArgs[0],
		publication as unknown as AttachArgs[1],
		publication.track as unknown as AttachArgs[2],
	);
}

function detachOnMute(adapter: Adapter, publication: ReturnType<typeof fakePublication>): void {
	adapter.detachIfTrackMatches(participant as unknown as AttachArgs[0], publication as unknown as AttachArgs[1]);
}

beforeEach(() => {
	context = new FakeAudioContext();
	vi.stubGlobal('window', {setInterval, clearInterval});
	vi.stubGlobal(
		'MediaStream',
		class {
			constructor(readonly tracks: Array<unknown>) {}
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	boost.exempt = false;
	boost.clear.mockClear();
	boost.set.mockClear();
	signalLevel = 0;
});

describe('remote speaking analyser source nodes', () => {
	it('mute and unmute of the same track reuse one source node', () => {
		const adapter = new VoiceEngineV2AppRemoteSpeakingAdapter({autoSchedule: false});
		const publication = fakePublication(fakeTrack());
		attach(adapter, publication);
		for (let i = 0; i < 10; i++) {
			detachOnMute(adapter, publication);
			expect(adapter.analyserCount).toBe(0);
			attach(adapter, publication);
			expect(adapter.analyserCount).toBe(1);
		}
		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1);
	});

	it('a reused source node is reconnected to its analyser', () => {
		const adapter = new VoiceEngineV2AppRemoteSpeakingAdapter({autoSchedule: false});
		const publication = fakePublication(fakeTrack());
		attach(adapter, publication);
		const [source] = context.sources;
		detachOnMute(adapter, publication);
		expect(source!.disconnect).toHaveBeenCalled();
		attach(adapter, publication);
		expect(source!.connect).toHaveBeenCalledTimes(2);
	});

	it('a new track for the same participant gets its own source and drops the old one', () => {
		const adapter = new VoiceEngineV2AppRemoteSpeakingAdapter({autoSchedule: false});
		const first = fakePublication(fakeTrack());
		attach(adapter, first);
		const second = fakePublication(fakeTrack());
		attach(adapter, second);
		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
		expect(context.sources[0]!.disconnect).toHaveBeenCalled();
		detachOnMute(adapter, second);
		attach(adapter, first);
		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(3);
	});

	it('after a track ends, the ended track stays detached and its replacement gets a source', () => {
		const adapter = new VoiceEngineV2AppRemoteSpeakingAdapter({autoSchedule: false});
		const ended = fakePublication(fakeTrack());
		attach(adapter, ended);
		ended.track.mediaStreamTrack.readyState = 'ended';
		adapter.tickHost(performance.now() + 1_000);
		expect(adapter.analyserCount).toBe(0);
		attach(adapter, ended);
		expect(adapter.analyserCount).toBe(0);
		const replacement = fakePublication(fakeTrack());
		attach(adapter, replacement);
		expect(adapter.analyserCount).toBe(1);
		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
	});

	it('a new audio context gets new source nodes', () => {
		const adapter = new VoiceEngineV2AppRemoteSpeakingAdapter({autoSchedule: false});
		const publication = fakePublication(fakeTrack());
		attach(adapter, publication);
		detachOnMute(adapter, publication);
		const previous = context;
		previous.state = 'closed';
		context = new FakeAudioContext();
		attach(adapter, publication);
		expect(previous.createMediaStreamSource).toHaveBeenCalledTimes(1);
		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1);
	});
});

describe('remote playback boost for an exempt voice', () => {
	function tickFor(adapter: Adapter, fromMs: number, durationMs: number): number {
		let nowMs = fromMs;
		for (; nowMs < fromMs + durationMs; nowMs += 50) adapter.tickHost(nowMs);
		return nowMs;
	}

	it('drops a built-up boost back to unity as soon as the voice is exempt, and keeps it there', () => {
		const adapter = new VoiceEngineV2AppRemoteSpeakingAdapter({autoSchedule: false});
		attach(adapter, fakePublication(fakeTrack()));
		signalLevel = 0.003;
		const nowMs = tickFor(adapter, 100, 5_000);
		expect(Math.max(...boost.set.mock.calls.map(([, value]) => value as number))).toBeGreaterThan(1);
		boost.clear.mockClear();
		boost.set.mockClear();
		boost.exempt = true;
		tickFor(adapter, nowMs, 5_000);
		expect(boost.clear.mock.calls).toEqual([[participant.identity]]);
		expect(boost.set).not.toHaveBeenCalled();
	});
});
