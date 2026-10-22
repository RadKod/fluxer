// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BandLeaderController} from '@app/features/activities/band/flow/BandLeaderController';
import type {BandMicPort} from '@app/features/activities/band/flow/BandMicGuard';
import {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandSongLibrary} from '@app/features/activities/band/flow/BandSongLibrary';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/activities/band/flow/BandMicPort', () => ({VOICE_MIC_PORT: null}));
vi.mock('@app/features/activities/state/VoiceActivities', () => ({default: {live: null}}));

const SONG: BandSongSummary = {
	id: 'duman-bir-daha',
	name: 'Bir Daha',
	artist: 'Duman',
	lengthMs: 5_000,
	parts: {guitar: ['expert']},
	stems: true,
	coverUrl: null,
	packageUrl: 'https://dl.example/duman-bir-daha.sng',
	packageBytes: 1,
	addedBy: null,
};

const MIC_PORT: BandMicPort = {
	hasPushToTalkKey: () => false,
	transmitMode: () => 'voice_activity',
	setTransmitMode: () => {},
	isMuted: () => false,
	isDeafened: () => false,
	toggleMute: async () => {},
	setMuted: () => {},
};

// The index comes from a stubbed fetch; the package resolves when the test says it finished downloading.
class StubLibrary extends BandSongLibrary {
	finishDownload: (songPackage: SongPackage) => void = () => {};

	constructor() {
		super({
			fetch: async () => new Response(JSON.stringify({songs: [SONG]})),
			cacheStorage: null,
		});
	}

	override ensure(): Promise<SongPackage> {
		return new Promise((resolve) => {
			this.finishDownload = resolve;
		});
	}
}

describe('BandRoom', () => {
	let session: FakeActivitySession;
	let library: StubLibrary;
	let room: BandRoom;

	beforeEach(async () => {
		vi.useFakeTimers({now: 1_700_000_000_000});
		vi.stubGlobal('window', new EventTarget());
		session = new FakeActivitySession({activityId: 'band', myUserId: 'me', localNow: () => Date.now()});
		const select: BandState = {
			phase: 'select',
			songId: SONG.id,
			groupDifficulty: 'expert',
			seats: [{part: 'guitar', userId: 'me', difficulty: 'expert', ready: false, loaded: false}],
			watching: [],
			endsAt: Date.now() + 20_000,
			loadWaitUntil: null,
		};
		session.setState(select);
		library = new StubLibrary();
		room = new BandRoom(session, {library, micPort: MIC_PORT});
		await vi.advanceTimersByTimeAsync(0);
	});

	afterEach(() => {
		room.dispose();
		session.dispose();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('does not send ready while the song is still downloading', () => {
		const sendIntent = vi.spyOn(BandLeaderController.prototype, 'sendIntent');
		expect(room.songPackage).toMatchObject({songId: SONG.id, status: 'loading'});
		room.send({t: 'band.ready', ready: true});
		expect(sendIntent).not.toHaveBeenCalled();
		room.send({t: 'band.ready', ready: false});
		expect(sendIntent).toHaveBeenCalledWith({t: 'band.ready', ready: false});
		expect(room.mySeat).toMatchObject({ready: false, loaded: false});
		expect(room.state?.phase).toBe('select');
	});

	it('reports the package once it is open, then lets ready start the song', async () => {
		library.finishDownload({} as SongPackage);
		await vi.advanceTimersByTimeAsync(0);
		expect(room.songLoaded).toBe(true);
		expect(room.mySeat).toMatchObject({loaded: true, ready: false});
		room.send({t: 'band.ready', ready: true});
		expect(room.state?.phase).toBe('play');
	});
});
