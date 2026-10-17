// SPDX-License-Identifier: AGPL-3.0-or-later

import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import type {VoiceActivitySessionMetadata} from '@fluxer/constants/src/VoiceActivityConstants';
import {beforeEach, describe, expect, it} from 'vitest';

function session(sessionId: string): VoiceActivitySessionMetadata {
	return {activity_id: 'band', session_id: sessionId, started_by: '1', started_at: 0};
}

beforeEach(() => VoiceActivities.reset());

describe('VoiceActivities', () => {
	it('opens the panel when a session starts', () => {
		VoiceActivities.handleSession('500', session('s1'));
		expect(VoiceActivities.getSession('500')?.session_id).toBe('s1');
		expect(VoiceActivities.isPanelOpen('500')).toBe(true);
		expect(VoiceActivities.isPanelOpen('600')).toBe(false);
	});

	it('leaves a closed panel closed when the same session is read again', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.closePanel();
		VoiceActivities.handleSession('500', session('s1'));
		expect(VoiceActivities.isPanelOpen('500')).toBe(false);
		VoiceActivities.togglePanel();
		expect(VoiceActivities.isPanelOpen('500')).toBe(true);
	});

	it('closes the panel when the session ends and opens it again for the next one', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.handleSession('500', null);
		expect(VoiceActivities.getSession('500')).toBeNull();
		expect(VoiceActivities.panelOpen).toBe(false);
		VoiceActivities.openPanel();
		expect(VoiceActivities.panelOpen).toBe(false);
		VoiceActivities.handleSession('500', session('s2'));
		expect(VoiceActivities.isPanelOpen('500')).toBe(true);
	});

	it('forgets the session and a pending request when I leave the channel', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.setRequest('end');
		VoiceActivities.handleSession(null, null);
		expect(VoiceActivities.session).toBeNull();
		expect(VoiceActivities.request).toBeNull();
		expect(VoiceActivities.isPanelOpen('500')).toBe(false);
	});

	it('does not reopen a session seen before a reconnect to another channel and back', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.closePanel();
		VoiceActivities.handleSession('600', null);
		VoiceActivities.handleSession('500', session('s1'));
		expect(VoiceActivities.isPanelOpen('500')).toBe(false);
	});

	it('hands out the live session only for the running one', () => {
		VoiceActivities.handleSession('500', session('s1'));
		const live = {channelId: '500', sessionId: 's1'} as never;
		VoiceActivities.setLive(live);
		expect(VoiceActivities.getLive('500')).toBe(live);
		VoiceActivities.handleSession('500', session('s2'));
		expect(VoiceActivities.getLive('500')).toBeNull();
	});
});
