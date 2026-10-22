// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BandLeaderController} from '@app/features/activities/band/flow/BandLeaderController';
import type {BandMicPort} from '@app/features/activities/band/flow/BandMicGuard';
import {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import type {BandSingerOutputStorage, BandVoicePort} from '@app/features/activities/band/flow/BandSingerVoice';
import {BandSongLibrary} from '@app/features/activities/band/flow/BandSongLibrary';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/activities/band/flow/BandMicPort', () => ({VOICE_MIC_PORT: null, VOICE_SINGER_PORT: null}));
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
	groups: [],
	genre: null,
	year: null,
	previewStartMs: null,
	key: null,
};

const VOICE_PORT: BandVoicePort = {setSingerMic: () => {}, setUnlevelledVoices: () => {}};

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
		room = new BandRoom(session, {library, micPort: MIC_PORT, voicePort: VOICE_PORT});
		await vi.advanceTimersByTimeAsync(0);
	});

	afterEach(() => {
		room.dispose();
		session.dispose();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('counts only the people who joined, so someone chatting in the call holds nothing up', () => {
		session.connectPeer('chatter', {joined: false});
		session.connectPeer('player');
		expect([...room.context.presentUserIds].sort()).toEqual(['me', 'player']);
		expect(room.spectatorIds).toEqual(['player']);
	});

	it('remembers the freestyle solo choice per user and puts it on my seat in every song', () => {
		const stored = new Map<string, string>();
		const storage = () => ({
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => void stored.set(key, value),
		});
		room.dispose();
		room = new BandRoom(session, {library, micPort: MIC_PORT, voicePort: VOICE_PORT, freestyleStorage: storage});
		expect(room.freestyleSolo).toBe(false);
		expect(room.mySeat).not.toHaveProperty('freestyleSolo');
		room.setFreestyleSolo(true);
		expect(stored.get('sanalyer:band-freestyle-solo:me')).toBe('on');
		expect(room.mySeat).toMatchObject({part: 'guitar', freestyleSolo: true});

		room.dispose();
		session.setState({
			phase: 'select',
			songId: SONG.id,
			groupDifficulty: 'expert',
			seats: [{part: 'guitar', userId: 'me', difficulty: 'expert', ready: false}],
			watching: [],
			endsAt: Date.now() + 20_000,
		});
		room = new BandRoom(session, {library, micPort: MIC_PORT, voicePort: VOICE_PORT, freestyleStorage: storage});
		expect(room.freestyleSolo).toBe(true);
		expect(room.mySeat).toMatchObject({freestyleSolo: true});
		room.setFreestyleSolo(false);
		expect(room.mySeat).not.toHaveProperty('freestyleSolo');
		expect(stored.get('sanalyer:band-freestyle-solo:me')).toBe('off');
	});

	it('keeps freestyle off when storage refuses', () => {
		room.dispose();
		const refusing = () => {
			throw new Error('denied');
		};
		room = new BandRoom(session, {library, micPort: MIC_PORT, voicePort: VOICE_PORT, freestyleStorage: refusing});
		expect(room.freestyleSolo).toBe(false);
		room.setFreestyleSolo(true);
		expect(room.freestyleSolo).toBe(true);
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

	it('reports the package again when the first report is lost', async () => {
		const lost = vi.spyOn(BandLeaderController.prototype, 'sendIntent').mockImplementation(() => {});
		library.finishDownload({} as SongPackage);
		await vi.advanceTimersByTimeAsync(0);
		expect(room.mySeat).toMatchObject({loaded: false});
		lost.mockRestore();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(room.mySeat).toMatchObject({loaded: true});
	});

	it('reports a package already on disk when I take a seat afterwards', async () => {
		session.setState({
			phase: 'select',
			songId: SONG.id,
			groupDifficulty: 'expert',
			seats: [],
			watching: [],
			endsAt: Date.now() + 20_000,
			loadWaitUntil: null,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(room.mySeat).toBeUndefined();
		library.finishDownload({} as SongPackage);
		await vi.advanceTimersByTimeAsync(0);
		expect(room.songLoaded).toBe(true);
		room.send({t: 'band.claimSeat', part: 'guitar'});
		await vi.advanceTimersByTimeAsync(0);
		expect(room.mySeat).toMatchObject({part: 'guitar', loaded: true});
		room.send({t: 'band.ready', ready: true});
		expect(room.state?.phase).toBe('play');
	});
});

describe('BandRoom singer voice', () => {
	const COUNTDOWN_MS = 4_000;
	let session: FakeActivitySession;
	let voicePort: {setSingerMic: ReturnType<typeof vi.fn>; setUnlevelledVoices: ReturnType<typeof vi.fn>};
	let stored: Map<string, string>;
	let room: BandRoom | null;

	const storage = (): BandSingerOutputStorage => ({
		getItem: (key) => stored.get(key) ?? null,
		setItem: (key, value) => void stored.set(key, value),
	});

	function playState(vocalsUserId: string, startAt = Date.now() + COUNTDOWN_MS): BandState {
		return {
			phase: 'play',
			songId: SONG.id,
			startAt,
			seats: [
				{part: 'vocals', userId: vocalsUserId, difficulty: 'expert', ready: true, loaded: true},
				{part: 'guitar', userId: vocalsUserId === 'me' ? 'friend' : 'me', difficulty: 'expert', ready: true},
			],
		};
	}

	function resultsState(): BandState {
		return {phase: 'results', songId: SONG.id, seats: [], results: [], ratings: {}, endsAt: Date.now() + 25_000};
	}

	function openRoom(): BandRoom {
		room = new BandRoom(session, {
			library: new StubLibrary(),
			micPort: MIC_PORT,
			voicePort: voicePort as unknown as BandVoicePort,
			singerOutputStorage: storage,
		});
		return room;
	}

	beforeEach(() => {
		vi.useFakeTimers({now: 1_700_000_000_000});
		vi.stubGlobal('window', new EventTarget());
		session = new FakeActivitySession({activityId: 'band', myUserId: 'me', localNow: () => Date.now()});
		voicePort = {setSingerMic: vi.fn(), setUnlevelledVoices: vi.fn()};
		stored = new Map();
		room = null;
	});

	afterEach(() => {
		room?.dispose();
		session.dispose();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('switches my mic to music processing in the countdown and back when the song ends', () => {
		openRoom();
		session.setState(playState('me'));
		expect(voicePort.setSingerMic.mock.calls).toEqual([['speakers']]);
		vi.advanceTimersByTime(COUNTDOWN_MS + 1_000);
		expect(voicePort.setSingerMic).toHaveBeenCalledTimes(1);
		session.setState(resultsState());
		expect(voicePort.setSingerMic.mock.calls).toEqual([['speakers'], [null]]);
	});

	it('defaults to speakers and remembers headphones per user', () => {
		const first = openRoom();
		expect(first.singerOutput).toBe('speakers');
		first.setSingerOutput('headphones');
		expect(stored.get('sanalyer:band-singer-output:me')).toBe('headphones');
		first.dispose();
		const second = openRoom();
		expect(second.singerOutput).toBe('headphones');
		session.setState(playState('me'));
		expect(voicePort.setSingerMic).toHaveBeenLastCalledWith('headphones');
	});

	it('keeps the default when storage refuses', () => {
		room = new BandRoom(session, {
			library: new StubLibrary(),
			micPort: MIC_PORT,
			voicePort: voicePort as unknown as BandVoicePort,
			singerOutputStorage: () => {
				throw new Error('denied');
			},
		});
		expect(room.singerOutput).toBe('speakers');
		room.setSingerOutput('headphones');
		expect(room.singerOutput).toBe('headphones');
	});

	it('does not switch mid-song: a choice changed during the song waits for the next one', () => {
		const current = openRoom();
		session.setState(playState('me'));
		current.setSingerOutput('headphones');
		expect(voicePort.setSingerMic.mock.calls).toEqual([['speakers']]);
	});

	it('leaves the mic alone when the song was already playing when I first saw it', () => {
		openRoom();
		session.setState(playState('me', Date.now() - 1_000));
		expect(voicePort.setSingerMic).not.toHaveBeenCalled();
		session.setState(resultsState());
		expect(voicePort.setSingerMic).not.toHaveBeenCalled();
	});

	it('puts my mic back when I lose the vocals seat', () => {
		openRoom();
		session.setState(playState('me'));
		session.setState(playState('friend'));
		expect(voicePort.setSingerMic.mock.calls).toEqual([['speakers'], [null]]);
	});

	it('puts my mic back and levels everyone again when the room goes away', () => {
		const current = openRoom();
		session.setState(playState('me'));
		current.dispose();
		expect(voicePort.setSingerMic.mock.calls).toEqual([['speakers'], [null]]);
		expect(voicePort.setUnlevelledVoices).toHaveBeenLastCalledWith([]);
	});

	it('stops levelling whoever sings while the song plays, and only then', () => {
		openRoom();
		expect(voicePort.setUnlevelledVoices.mock.calls).toEqual([[[]]]);
		session.setState(playState('friend'));
		expect(voicePort.setUnlevelledVoices).toHaveBeenLastCalledWith(['friend']);
		expect(voicePort.setSingerMic).not.toHaveBeenCalled();
		session.setState(resultsState());
		expect(voicePort.setUnlevelledVoices).toHaveBeenLastCalledWith([]);
		expect(voicePort.setUnlevelledVoices).toHaveBeenCalledTimes(3);
	});
});
