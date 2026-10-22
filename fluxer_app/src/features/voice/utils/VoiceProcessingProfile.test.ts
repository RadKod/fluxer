// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	applyMusicProcessing,
	type ResolvedVoiceProcessing,
	resolveVoiceProcessing,
} from '@app/features/voice/utils/VoiceProcessingProfile';
import {describe, expect, it} from 'vitest';

describe('resolveVoiceProcessing', () => {
	it('does not set a speech content hint on the focused voice profile', () => {
		const profile = resolveVoiceProcessing({
			voiceProcessingMode: 'voice',
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
			deepFilterNoiseSuppression: false,
			deepFilterNoiseSuppressionLevel: 100,
		});

		expect(profile.contentHint).toBe('');
	});
});

describe('applyMusicProcessing', () => {
	const talking: ResolvedVoiceProcessing = {
		pipelineV2Enabled: true,
		mode: 'voice',
		echoCancellation: true,
		browserNoiseSuppression: false,
		autoGainControl: true,
		deepFilter: true,
		deepFilterNoiseReductionLevel: 80,
		contentHint: '',
		noiseSuppressionBackend: 'deep_filter',
		stereoCapture: false,
	};

	it('makes a headphone singer exactly the studio profile', () => {
		const studio = resolveVoiceProcessing({
			voiceProcessingMode: 'studio',
			echoCancellation: true,
			autoGainControl: true,
		});
		expect(applyMusicProcessing(talking, 'headphones')).toEqual(studio);
	});

	it('keeps echo cancellation for a singer on speakers and turns everything else off', () => {
		expect(applyMusicProcessing(talking, 'speakers')).toEqual({
			pipelineV2Enabled: false,
			mode: 'studio',
			echoCancellation: true,
			browserNoiseSuppression: false,
			autoGainControl: false,
			deepFilter: false,
			deepFilterNoiseReductionLevel: 0,
			contentHint: 'music',
			noiseSuppressionBackend: 'none',
			stereoCapture: false,
		});
	});

	it('leaves stereo capture as it was, so the mic is never re-published for a song', () => {
		const stereo = {...talking, mode: 'studio' as const, stereoCapture: true};
		expect(applyMusicProcessing(stereo, 'headphones').stereoCapture).toBe(true);
		expect(applyMusicProcessing(stereo, 'speakers').stereoCapture).toBe(true);
		expect(applyMusicProcessing(talking, 'headphones').stereoCapture).toBe(false);
	});
});
