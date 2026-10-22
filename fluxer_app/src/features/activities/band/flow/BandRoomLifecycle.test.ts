// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {observable, runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const store = observable({live: null as ActivitySession | null});

vi.mock('@app/features/activities/band/flow/BandMicPort', () => ({
	VOICE_MIC_PORT: {
		hasPushToTalkKey: () => false,
		transmitMode: () => 'voice_activity',
		setTransmitMode: () => {},
		isMuted: () => false,
		isDeafened: () => false,
		toggleMute: async () => {},
		setMuted: () => {},
	},
	VOICE_SINGER_PORT: {setSingerMic: () => {}, setUnlevelledVoices: () => {}},
}));
vi.mock('@app/features/activities/state/VoiceActivities', () => ({
	default: {
		get live() {
			return store.live;
		},
	},
}));

const {FakeActivitySession} = await import('@app/features/activities/band/dev/FakeActivitySession');
const {BandRoom, getBandRoom} = await import('@app/features/activities/band/flow/BandRoom');

function liveSession() {
	return new FakeActivitySession({activityId: 'band', myUserId: 'me'});
}

describe('getBandRoom', () => {
	beforeEach(() => {
		vi.stubGlobal('window', new EventTarget());
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({songs: []})));
	});

	afterEach(() => {
		runInAction(() => {
			store.live = null;
		});
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('keeps one room per session and ends it when I leave the activity', () => {
		const session = liveSession();
		runInAction(() => {
			store.live = session;
		});
		const room = getBandRoom(session);
		expect(room).toBeInstanceOf(BandRoom);
		expect(getBandRoom(session)).toBe(room);
		const dispose = vi.spyOn(room, 'dispose');
		session.setJoined(false);
		expect(dispose).toHaveBeenCalledTimes(1);
		session.setJoined(true);
		expect(getBandRoom(session)).not.toBe(room);
	});

	it('ends the room when the call moves on to another session', () => {
		const session = liveSession();
		runInAction(() => {
			store.live = session;
		});
		const room = getBandRoom(session);
		const dispose = vi.spyOn(room, 'dispose');
		runInAction(() => {
			store.live = liveSession();
		});
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
