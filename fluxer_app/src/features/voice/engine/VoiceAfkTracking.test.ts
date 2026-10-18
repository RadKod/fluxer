// SPDX-License-Identifier: AGPL-3.0-or-later

import {shouldMoveToAfkOnTick} from '@app/features/voice/engine/VoiceAfkTracking';
import {describe, expect, it} from 'vitest';

const idleTooLong = {
	hasRecentVoiceActivity: false,
	inActivitySession: false,
	channelId: 'voice',
	afkChannelId: 'afk',
	afkTimeoutSeconds: 300,
	inactiveDurationMs: 301_000,
};

describe('shouldMoveToAfkOnTick', () => {
	it('moves someone idle past the guild timeout', () => {
		expect(shouldMoveToAfkOnTick(idleTooLong)).toBe(true);
	});

	it('never moves someone in an activity session, whose keys never reach the window', () => {
		expect(shouldMoveToAfkOnTick({...idleTooLong, inActivitySession: true})).toBe(false);
	});

	it('does not move someone who is speaking', () => {
		expect(shouldMoveToAfkOnTick({...idleTooLong, hasRecentVoiceActivity: true})).toBe(false);
	});
});
