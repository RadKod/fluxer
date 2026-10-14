// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveVoiceProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
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
