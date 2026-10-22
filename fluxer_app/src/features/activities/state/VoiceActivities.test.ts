// SPDX-License-Identifier: AGPL-3.0-or-later

import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import type {VoiceActivitySessionMetadata} from '@fluxer/constants/src/VoiceActivityConstants';
import {beforeEach, describe, expect, it} from 'vitest';

function session(sessionId: string): VoiceActivitySessionMetadata {
	return {activity_id: 'band', session_id: sessionId, started_by: '1', started_at: 0};
}

beforeEach(() => VoiceActivities.reset());

describe('VoiceActivities', () => {
	it('never expands a new session by itself, for anyone', () => {
		VoiceActivities.handleSession('500', session('s1'));
		expect(VoiceActivities.getSession('500')?.session_id).toBe('s1');
		expect(VoiceActivities.isExpanded('500')).toBe(false);
		expect(VoiceActivities.isJoined('500')).toBe(false);
	});

	it('keeps the starter joined and collapsed when the started session arrives', () => {
		VoiceActivities.join('s1');
		VoiceActivities.handleSession('500', session('s1'));
		expect(VoiceActivities.isJoined('500')).toBe(true);
		expect(VoiceActivities.isExpanded('500')).toBe(false);
	});

	it('expands and collapses only on request, and not without a session', () => {
		VoiceActivities.expand();
		expect(VoiceActivities.expanded).toBe(false);
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.expand();
		expect(VoiceActivities.isExpanded('500')).toBe(true);
		expect(VoiceActivities.isExpanded('600')).toBe(false);
		VoiceActivities.collapse();
		expect(VoiceActivities.isExpanded('500')).toBe(false);
	});

	it('leaves the activity without leaving the session, and collapses it', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.join('s1');
		VoiceActivities.expand();
		VoiceActivities.leave();
		expect(VoiceActivities.isJoined('500')).toBe(false);
		expect(VoiceActivities.isExpanded('500')).toBe(false);
		expect(VoiceActivities.getSession('500')?.session_id).toBe('s1');
	});

	it('keeps my membership when the same session is read again, and drops it for the next one', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.join('s1');
		VoiceActivities.handleSession('500', session('s1'));
		expect(VoiceActivities.isJoined('500')).toBe(true);
		VoiceActivities.handleSession('500', null);
		expect(VoiceActivities.joinedSessionId).toBeNull();
		VoiceActivities.handleSession('500', session('s2'));
		expect(VoiceActivities.isJoined('500')).toBe(false);
	});

	it('forgets the session, my membership and a pending request when I leave the channel', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.join('s1');
		VoiceActivities.setRequest('end');
		VoiceActivities.handleSession(null, null);
		expect(VoiceActivities.session).toBeNull();
		expect(VoiceActivities.request).toBeNull();
		expect(VoiceActivities.joined).toBe(false);
	});

	it('brings a closed mini window back when asked or for a new session', () => {
		VoiceActivities.handleSession('500', session('s1'));
		VoiceActivities.closeMiniWindow();
		expect(VoiceActivities.miniWindowClosed).toBe(true);
		VoiceActivities.reopenMiniWindow();
		expect(VoiceActivities.miniWindowClosed).toBe(false);
		VoiceActivities.closeMiniWindow();
		VoiceActivities.handleSession('500', session('s2'));
		expect(VoiceActivities.miniWindowClosed).toBe(false);
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
