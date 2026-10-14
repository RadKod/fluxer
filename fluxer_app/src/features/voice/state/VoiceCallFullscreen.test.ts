// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it} from 'vitest';
import VoiceCallFullscreen from './VoiceCallFullscreen';

beforeEach(() => VoiceCallFullscreen.close());

describe('fullscreen presentation intent', () => {
	it('retains the existing room action by default', () => {
		VoiceCallFullscreen.open('guild-voice:c');
		expect(VoiceCallFullscreen.activePresentation).toBe('room');
	});

	it.each(['guild-voice:c', 'dm-call:c'])('scopes a compact call request to %s', (scopeKey) => {
		VoiceCallFullscreen.open(scopeKey, 'call');
		expect(VoiceCallFullscreen.isCallViewRequested(scopeKey)).toBe(true);
		expect(VoiceCallFullscreen.isCallViewRequested('guild-voice:other')).toBe(false);
	});

	it('preserves the active call when a different scope closes', () => {
		VoiceCallFullscreen.open('guild-voice:c', 'call');
		VoiceCallFullscreen.close('guild-voice:other');
		expect(VoiceCallFullscreen.isCallViewRequested('guild-voice:c')).toBe(true);
	});

	it('clears compact intent on exit and on the next explicit room entry', () => {
		VoiceCallFullscreen.open('guild-voice:c', 'call');
		VoiceCallFullscreen.close('guild-voice:c');
		expect(VoiceCallFullscreen.activeScopeKey).toBeNull();
		expect(VoiceCallFullscreen.activePresentation).toBe('room');
		VoiceCallFullscreen.open('guild-voice:c');
		expect(VoiceCallFullscreen.isCallViewRequested('guild-voice:c')).toBe(false);
	});
});
