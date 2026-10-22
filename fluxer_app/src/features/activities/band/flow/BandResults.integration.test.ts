// SPDX-License-Identifier: AGPL-3.0-or-later

// Getting every player's score to the leader over a real-latency room: the leader on the fake session, two peers,
// and each player's client reporting the way the play screen does: once its own song end has been heard, or at once
// with what it has when the play phase goes away first (the leader stopped the song, or the screen closed).

import type {
	BandIntent,
	BandPlayerResult,
	BandSongSummary,
	BandState,
} from '@app/features/activities/band/BandProtocol';
import {FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import {BandLeaderController} from '@app/features/activities/band/flow/BandLeaderController';
import {resultsWaitEndsAt} from '@app/features/activities/band/flow/BandRoomMachine';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));

// The index says 8 s, but the chart's last chord rings until 9.5 s, as in several songs of the real library.
const SONG: BandSongSummary = {
	id: 'mor-ve-otesi-araf',
	name: 'Araf',
	artist: 'mor ve ötesi',
	lengthMs: 8_000,
	parts: {guitar: ['medium'], bass: ['medium'], drums: ['medium']},
	stems: true,
	coverUrl: null,
	packageUrl: 'http://127.0.0.1/araf.sng',
	packageBytes: 1,
	addedBy: null,
	groups: [],
	genre: null,
	year: null,
	previewStartMs: null,
};
const CHART_END_MS = 9_500;
const NOTES = [1_000, 2_000, 3_000, 5_000, 7_000, 9_500];
// PlayRuntime: the client's song is over this long after the chart's last note, or at the index length if later.
const CLIENT_SONG_END_MS = Math.max(CHART_END_MS + 1_500, SONG.lengthMs);
const LATENCY_MS = 120;
// Speaker latency plus the calibrated input offset: the client's judge clock runs this far behind the leader's.
const HEARD_LAG_MS = 250;

type PlayState = Extract<BandState, {phase: 'play'}>;
type ResultsState = Extract<BandState, {phase: 'results'}>;

// One player's play screen, as far as reporting goes.
class PlayerClient {
	private startAt: number | null = null;
	private part: BandPart = 'guitar';
	private finished = false;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly userId: string,
		private readonly submit: (intent: BandIntent) => void,
		private readonly loads = true,
	) {}

	onState(state: BandState | null): void {
		if (state?.phase === 'play') {
			const seat = state.seats.find((candidate) => candidate.userId === this.userId);
			if (seat && this.loads && this.startAt === null) this.start(state, seat.part);
			return;
		}
		if (this.startAt !== null && !this.finished) this.finish(Date.now() - this.startAt - HEARD_LAG_MS);
	}

	private start(state: PlayState, part: BandPart): void {
		this.startAt = state.startAt;
		this.part = part;
		this.timer = setTimeout(
			() => this.finish(Number.POSITIVE_INFINITY),
			state.startAt + CLIENT_SONG_END_MS + HEARD_LAG_MS - Date.now(),
		);
	}

	private finish(songMs: number): void {
		if (this.finished) return;
		this.finished = true;
		if (this.timer) clearTimeout(this.timer);
		const hit = NOTES.filter((noteMs) => noteMs <= songMs).length;
		const result: Omit<BandPlayerResult, 'userId'> = {
			part: this.part,
			difficulty: 'medium',
			score: hit * 50,
			rawScore: hit * 50,
			accuracy: hit === 0 ? 0 : 1,
			bestStreak: hit,
			notesHit: hit,
			notesMissed: 0,
			starPowerUses: 0,
		};
		this.submit({t: 'band.result', result});
	}
}

function setupRoom({secondPeerLoads = true}: {secondPeerLoads?: boolean} = {}) {
	const session = new FakeActivitySession({
		activityId: 'band',
		myUserId: 'lead',
		localNow: () => Date.now(),
		latencyMs: LATENCY_MS,
	});
	const controller = new BandLeaderController(session, () => ({
		leaderId: session.leader?.userId ?? null,
		presentUserIds: new Set(session.participants.map((participant) => participant.userId)),
		songs: new Map([[SONG.id, SONG]]),
	}));
	const toLeader = {to: [session.me.identity]};
	const ayse = session.connectPeer('ayse');
	const mert = session.connectPeer('mert');
	const clients = [
		new PlayerClient('lead', (intent) => controller.sendIntent(intent)),
		new PlayerClient('ayse', (intent) => ayse.send(intent, toLeader)),
		new PlayerClient('mert', (intent) => mert.send(intent, toLeader), secondPeerLoads),
	];
	session.onStateChanged((state) => clients[0].onState(state as BandState));
	ayse.onStateChanged((state) => clients[1].onState(state as BandState));
	mert.onStateChanged((state) => clients[2].onState(state as BandState));
	controller.start();

	const state = () => session.state as BandState;
	const advanceUntil = async (phase: BandState['phase'], maxMs: number) => {
		for (let waited = 0; state().phase !== phase && waited < maxMs; waited += 50) {
			await vi.advanceTimersByTimeAsync(50);
		}
		expect(state().phase).toBe(phase);
	};
	const startSong = async () => {
		await vi.advanceTimersByTimeAsync(LATENCY_MS * 2);
		controller.sendIntent({t: 'band.playNow', songId: SONG.id});
		await vi.advanceTimersByTimeAsync(LATENCY_MS * 2);
		const loaded: BandIntent = {t: 'band.loaded', songId: SONG.id};
		controller.sendIntent({t: 'band.claimSeat', part: 'guitar'});
		controller.sendIntent(loaded);
		controller.sendIntent({t: 'band.ready', ready: true});
		ayse.send({t: 'band.claimSeat', part: 'bass'}, toLeader);
		ayse.send(loaded, toLeader);
		ayse.send({t: 'band.ready', ready: true}, toLeader);
		mert.send({t: 'band.claimSeat', part: 'drums'}, toLeader);
		mert.send(loaded, toLeader);
		mert.send({t: 'band.ready', ready: true}, toLeader);
		await advanceUntil('play', 1_000);
		return (state() as PlayState).startAt;
	};
	const dispose = () => {
		controller.stop();
		session.dispose();
	};
	return {session, controller, state, advanceUntil, startSong, dispose};
}

function hitsByPlayer(state: ResultsState): Record<string, number> {
	return Object.fromEntries(state.results.map((result) => [result.userId, result.notesHit]));
}

describe('band results over a real-latency room', () => {
	beforeEach(() => {
		vi.useFakeTimers({now: 1_700_000_000_000});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('gets every full score when the chart runs past the index length', async () => {
		const room = setupRoom();
		const startAt = await room.startSong();
		// Where the leader used to close the song (length + 2 s): everyone is still playing the last chord.
		await vi.advanceTimersByTimeAsync(startAt + SONG.lengthMs + 2_000 - Date.now());
		expect(room.state().phase).toBe('play');

		await room.advanceUntil('results', CLIENT_SONG_END_MS);
		const results = room.state() as ResultsState;
		expect(hitsByPlayer(results)).toEqual({lead: NOTES.length, ayse: NOTES.length, mert: NOTES.length});
		// The song closes as soon as the last report lands, not at the deadline.
		expect(Date.now()).toBeLessThan(startAt + CLIENT_SONG_END_MS + HEARD_LAG_MS + 3 * LATENCY_MS);
		room.dispose();
	});

	it('takes partial scores from everyone when the leader stops the song', async () => {
		const room = setupRoom();
		const startAt = await room.startSong();
		await vi.advanceTimersByTimeAsync(startAt + 4_000 - Date.now());
		room.controller.sendIntent({t: 'band.skip'});
		expect(room.state().phase).toBe('results');

		await vi.advanceTimersByTimeAsync(LATENCY_MS * 3);
		// Notes up to 3 s had been heard everywhere; the peers saw the stop one latency later than the leader.
		expect(hitsByPlayer(room.state() as ResultsState)).toEqual({lead: 3, ayse: 3, mert: 3});
		room.dispose();
	});

	it('closes the song without a player whose song never loaded, and stops waiting for that score', async () => {
		const room = setupRoom({secondPeerLoads: false});
		const startAt = await room.startSong();
		await vi.advanceTimersByTimeAsync(startAt + CLIENT_SONG_END_MS + 1_000 - Date.now());
		expect(room.state().phase).toBe('play');

		await room.advanceUntil('results', 15_000);
		const results = room.state() as ResultsState;
		expect(hitsByPlayer(results)).toEqual({lead: NOTES.length, ayse: NOTES.length});
		expect(results.seats.map((seat) => seat.userId)).toContain('mert');
		expect(resultsWaitEndsAt(results)).toBeLessThan(results.endsAt);
		room.dispose();
	});
});
