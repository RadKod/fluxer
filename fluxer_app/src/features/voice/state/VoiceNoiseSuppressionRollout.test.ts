// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {
	type ExperimentAssignmentsResponse,
	INERT_EXPERIMENT_ASSIGNMENTS_RESPONSE,
} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {observable, runInAction} from 'mobx';
import {afterEach, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => {
	const descriptor = (value: unknown): unknown => (typeof value === 'string' ? {message: value} : value);
	return {msg: descriptor, t: descriptor, plural: () => '', select: () => '', selectOrdinal: () => ''};
});
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({
	default: {
		get response() {
			return experiments.get();
		},
	},
}));
vi.mock('@app/features/permissions/system/state/MediaPermission', () => ({
	default: {
		isMicrophoneGranted: () => true,
		isCameraGranted: () => true,
		isInitialized: () => true,
		getMicrophonePermissionState: () => 'granted',
		getCameraPermissionState: () => 'granted',
		addChangeListener: (listener: () => void) => {
			listener();
			return () => {};
		},
	},
}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {
		getState: () => ({inputDevices: [], permissionStatus: {audio: 'idle', video: 'idle'}}),
		ensureDevices: async () => {},
		whenDevicesInUse: async () => {},
	},
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({
	default: {
		inputDeviceId: 'default',
		voiceProcessingMode: 'voice',
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		deepFilterNoiseSuppression: false,
		deepFilterNoiseSuppressionLevel: 30,
		getVoiceProcessingModeForDeviceLabel: () => 'voice',
		getEchoCancellation: () => true,
		getNoiseSuppression: () => true,
		getAutoGainControl: () => true,
		getDeepFilterNoiseSuppression: () => false,
		getDeepFilterNoiseSuppressionLevel: () => 30,
		getNoiseSuppressionBackend: () => null,
		getStereoMicrophone: () => false,
	},
}));

import NoiseSuppressionAvailability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';

const experiments = observable.box(INERT_EXPERIMENT_ASSIGNMENTS_RESPONSE, {deep: false});
const APP_WIDE_DEEP_FILTER: ExperimentAssignmentsResponse = {
	...INERT_EXPERIMENT_ASSIGNMENTS_RESPONSE,
	assignments: {
		...INERT_EXPERIMENT_ASSIGNMENTS_RESPONSE.assignments,
		voice_noise_suppression: {
			...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			config_version: 9,
			user_targeted: true,
			backend: 'deep_filter',
			source: 'canary',
			enabled_backends: ['deep_filter'],
		},
	},
};

const isDeepFilterAsset = (url: string) => /df_bg\.wasm|DeepFilterNet3_onnx/.test(url);

afterEach(() => vi.unstubAllGlobals());

it('does not load DeepFilter assets at startup when an app-wide assignment arrives, only once a microphone graph runs', async () => {
	vi.stubGlobal('AudioWorkletNode', class {});
	const fetchMock = vi.fn((_input: unknown) => new Promise<Response>(() => {}));
	vi.stubGlobal('fetch', fetchMock);
	const deepFilterRequests = () => fetchMock.mock.calls.map(([input]) => String(input)).filter(isDeepFilterAsset);
	const settle = async () => {
		await import('@app/features/voice/utils/noise_suppression/DeepFilter');
		await new Promise((resolve) => setTimeout(resolve, 20));
	};
	await import('./VoiceNoiseSuppressionRollout');
	const {startMediaDeviceStartupPreload} = await import('@app/features/voice/utils/MediaDeviceStartupPreload');
	const stopPreload = startMediaDeviceStartupPreload();
	const owner = {};
	try {
		await settle();
		runInAction(() => {
			experiments.set(APP_WIDE_DEEP_FILTER);
		});
		await settle();
		expect(deepFilterRequests()).toEqual([]);
		expect(NoiseSuppressionAvailability.deepFilterAssets).toBe('idle');

		NoiseSuppressionAvailability.setVoiceInputRuntime(owner, 'standard', {}, null);
		await vi.waitFor(() => expect(deepFilterRequests()).toHaveLength(2));
	} finally {
		NoiseSuppressionAvailability.clearVoiceInputRuntime(owner);
		stopPreload();
	}
});
