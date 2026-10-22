// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	isRemoteVoicePlaybackBoostExempt,
	setRemoteVoicePlaybackBoostExemptUserIds,
} from '@app/features/voice/state/RemoteVoicePlaybackBoost';
import {afterEach, describe, expect, it} from 'vitest';

afterEach(() => setRemoteVoicePlaybackBoostExemptUserIds([]));

describe('remote playback boost exemptions', () => {
	it('exempts every connection of an exempt user and nobody else', () => {
		setRemoteVoicePlaybackBoostExemptUserIds(['111']);
		expect(isRemoteVoicePlaybackBoostExempt('user_111_desktop')).toBe(true);
		expect(isRemoteVoicePlaybackBoostExempt('user_111_phone')).toBe(true);
		expect(isRemoteVoicePlaybackBoostExempt('user_222_desktop')).toBe(false);
		expect(isRemoteVoicePlaybackBoostExempt('not-a-voice-identity')).toBe(false);
	});

	it('levels everyone again once the list is cleared', () => {
		setRemoteVoicePlaybackBoostExemptUserIds(['111']);
		setRemoteVoicePlaybackBoostExemptUserIds([]);
		expect(isRemoteVoicePlaybackBoostExempt('user_111_desktop')).toBe(false);
	});
});
