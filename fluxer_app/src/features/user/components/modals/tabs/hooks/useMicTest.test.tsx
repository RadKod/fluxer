// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {applyNoiseSuppressionOverride} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection';
import {VOICE_PIPELINE_TUNING, type VoicePipelineTuning} from '@app/features/voice/utils/VoicePipelineTuning';
import {resolveVoiceProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type MicTestSettings, useMicTest} from './useMicTest';

const state = vi.hoisted(() => ({
	pipelineV2Enabled: true,
	pipelineV2Failed: false,
	stereoPreferred: false,
	backend: 'standard' as 'standard' | 'none',
	pipelineV2Tuning: undefined as unknown as VoicePipelineTuning,
	listeners: new Set<() => void>(),
	createGraph: vi.fn(),
	resolveBackend: vi.fn(),
	beginSession: vi.fn(),
	acquireSource: vi.fn(),
}));
vi.mock('@app/features/permissions/system/commands/MacPermissionsModalCommands', () => ({
	handleMediaPermissionBlocked: vi.fn(),
}));
vi.mock('@app/features/permissions/system/state/MediaPermission', () => ({
	default: {microphoneExplicitlyDenied: false},
}));
vi.mock('@app/features/permissions/system/utils/MacPermissionGate', () => ({
	ensureMacPermission: async () => 'granted',
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		info() {}
		warn() {}
		error() {}
	},
}));
vi.mock('./MicTestAudioGraph', () => ({createMicTestAudioGraph: state.createGraph}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({
	acquireIdleVoiceInputSource: state.acquireSource,
}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({beginMicrophoneSession: state.beginSession}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability', () => ({
	default: {
		subscribe: (listener: () => void) => {
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		resolveEffectiveBackend: state.resolveBackend,
	},
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', async () => {
	const {applyNoiseSuppressionOverride} = await import(
		'@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection'
	);
	const effective = () => ({
		pipelineV2Enabled: state.pipelineV2Enabled,
		rolloutApplied: true,
		backend: state.backend,
		requestedBackend: state.backend,
		source: null,
		suppressionStrength: 80,
		stereoPreferred: state.stereoPreferred,
		configVersion: 1,
		pipelineV2Tuning: state.pipelineV2Tuning,
	});
	return {
		readEffectiveNoiseSuppression: effective,
		readNoiseSuppressionBackend: () => state.backend,
		readNoiseSuppressionStrength: () => effective().suppressionStrength,
		readRequestedNoiseSuppressionBackend: () => 'deep_filter',
		readVoicePipelineV2Enabled: () => state.pipelineV2Enabled && !state.pipelineV2Failed,
		resolveRuntimeVoiceProcessing: (profile: Parameters<typeof applyNoiseSuppressionOverride>[0]) =>
			applyNoiseSuppressionOverride(profile, {
				...effective(),
				pipelineV2Enabled: state.pipelineV2Enabled && !state.pipelineV2Failed,
			}),
	};
});
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({default: {}}));
vi.mock('@app/features/voice/utils/VoiceDeviceManager', () => ({resolveEffectiveDeviceId: vi.fn()}));

const settings: MicTestSettings = {
	inputDeviceId: 'default',
	outputDeviceId: 'default',
	inputVolume: 100,
	outputVolume: 100,
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
	deepFilterNoiseSuppression: true,
	deepFilterNoiseSuppressionLevel: 80,
	voiceProcessingMode: 'custom',
	stereoMicrophone: false,
};
let current: ReturnType<typeof useMicTest>;
let root: ReturnType<typeof createRoot>;
function Harness({value = settings}: {value?: MicTestSettings}) {
	current = useMicTest(value);
	return null;
}

beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	state.pipelineV2Enabled = true;
	state.pipelineV2Failed = false;
	state.stereoPreferred = false;
	state.backend = 'standard';
	state.pipelineV2Tuning = VOICE_PIPELINE_TUNING;
	state.listeners.clear();
	state.resolveBackend.mockReset().mockReturnValue('standard');
	state.beginSession.mockClear();
	state.createGraph.mockReset().mockImplementation(() => ({
		analyser: {fftSize: 128, getFloatTimeDomainData: vi.fn()},
		outputGain: {gain: {value: 1}},
		configure: vi.fn(async () => {}),
		dispose: vi.fn(),
	}));
	const track = {stop: vi.fn()};
	const stream = {getAudioTracks: () => [track], getTracks: () => [track]};
	state.acquireSource.mockReturnValue({
		lease: {context: {createMediaStreamDestination: () => ({stream, disconnect: vi.fn()})}, release: vi.fn()},
		source: {},
	});
	vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: vi.fn(async () => stream)}});
	vi.stubGlobal(
		'Audio',
		class {
			play = async () => {};
			pause() {}
		},
	);
	vi.stubGlobal(
		'requestAnimationFrame',
		vi.fn(() => 1),
	);
	vi.stubGlobal('cancelAnimationFrame', vi.fn());
	root = createRoot(document.createElement('div'));
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

describe('microphone preview v2 propagation', () => {
	it('matches the call mono pipeline when saved AGC makes custom stereo ineligible', async () => {
		const custom = {
			...settings,
			echoCancellation: false,
			noiseSuppression: false,
			deepFilterNoiseSuppression: false,
			stereoMicrophone: true,
		};
		state.backend = 'none';
		state.stereoPreferred = true;
		const call = applyNoiseSuppressionOverride(resolveVoiceProcessing(custom), {
			pipelineV2Enabled: true,
			rolloutApplied: true,
			backend: 'none',
			requestedBackend: 'none',
			source: null,
			suppressionStrength: 80,
			stereoPreferred: true,
			configVersion: 1,
			pipelineV2Tuning: VOICE_PIPELINE_TUNING,
		});
		expect(call).toMatchObject({stereoCapture: false, pipelineV2Enabled: true, autoGainControl: false});
		await act(async () => root.render(<Harness value={custom} />));
		await act(async () => current.start());
		const graph = state.createGraph.mock.calls[0][0];
		expect(graph.channelCount).toBe(call.stereoCapture ? 2 : 1);
		expect(graph.resolveConfig()).toMatchObject({
			pipelineV2Enabled: call.pipelineV2Enabled,
			backend: call.noiseSuppressionBackend,
		});
		expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
			audio: expect.objectContaining({autoGainControl: call.autoGainControl}),
		});
	});

	it('restores saved capture AGC on pipeline failure even if the backend does not change', async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => current.start());
		expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
			audio: expect.objectContaining({autoGainControl: false}),
		});
		await act(async () => {
			state.pipelineV2Failed = true;
			for (const listener of state.listeners) listener();
		});
		expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
		expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
			audio: expect.objectContaining({autoGainControl: true}),
		});
		expect(settings.autoGainControl).toBe(true);
	});
	it('passes the resolved pipeline flag to the graph and backend availability', async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => current.start());
		expect(state.createGraph).toHaveBeenCalledOnce();
		expect(state.createGraph.mock.calls[0][0].resolveConfig()).toMatchObject({
			pipelineV2Enabled: true,
			gateEnabled: false,
		});
		expect(state.resolveBackend).toHaveBeenCalledWith('deep_filter', true);
	});
	it('gives the preview graph the same pipeline tuning as calls', async () => {
		state.pipelineV2Tuning = {...VOICE_PIPELINE_TUNING, gateHangoverMs: 650, gainMaxDb: 9};
		await act(async () => root.render(<Harness />));
		await act(async () => current.start());
		expect(state.createGraph.mock.calls[0][0].resolveConfig().pipelineV2Tuning).toBe(state.pipelineV2Tuning);
	});

	it('refreshes capture when only the pipeline flag changes while preserving the session failure latch', async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => current.start());
		state.pipelineV2Enabled = false;
		await act(async () => root.render(<Harness />));
		expect(state.createGraph).toHaveBeenCalledTimes(2);
		expect(state.createGraph.mock.calls[1][0].resolveConfig().pipelineV2Enabled).toBe(false);
		expect(state.beginSession.mock.calls.every((args) => args.length === 1)).toBe(true);
	});
});
