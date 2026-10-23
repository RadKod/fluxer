// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const world = vi.hoisted(() => ({
	mobileLayout: false,
	joined: true,
	live: null as unknown,
}));

vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => world.mobileLayout}}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: {channelId: '500', guildId: '400'}}));
vi.mock('@app/features/activities/utils/VoiceActivityAvailability', () => ({voiceActivitiesEnabled: () => true}));
vi.mock('@app/features/activities/state/VoiceActivities', () => ({
	default: {isJoined: () => world.joined, getLive: () => world.live},
}));

const {joinedActivitySession, mountedActivitySession} = await import(
	'@app/features/activities/utils/JoinedActivitySession'
);

const SESSION = {sessionId: '77'} as ActivitySession;

beforeEach(() => {
	world.mobileLayout = false;
	world.joined = true;
	world.live = SESSION;
});

describe('mountedActivitySession', () => {
	it('mounts the joined session on the desktop layout', () => {
		expect(mountedActivitySession(null)).toBe(SESSION);
		expect(joinedActivitySession()).toBe(SESSION);
	});

	it('keeps a running View mounted when the window turns narrow, while the places that show it go', () => {
		world.mobileLayout = true;
		expect(mountedActivitySession(SESSION)).toBe(SESSION);
		expect(joinedActivitySession()).toBeNull();
	});

	it('never mounts a View on the mobile layout, and lets it go once I leave', () => {
		world.mobileLayout = true;
		expect(mountedActivitySession(null)).toBeNull();
		world.joined = false;
		expect(mountedActivitySession(SESSION)).toBeNull();
		world.joined = true;
		world.live = {sessionId: '78'};
		expect(mountedActivitySession(SESSION)).toBeNull();
	});
});
