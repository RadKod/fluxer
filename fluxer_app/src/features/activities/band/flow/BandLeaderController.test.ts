// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_PHASE_MS,
	type BandPlayerResult,
	type BandSongSummary,
	type BandState,
} from '@app/features/activities/band/BandProtocol';
import {
	BAND_TICK_MS,
	type BandControllerTimers,
	BandLeaderController,
} from '@app/features/activities/band/flow/BandLeaderController';
import {BAND_PLAY_GRACE_MS, type BandRoomContext} from '@app/features/activities/band/flow/BandRoomMachine';
import type {
	ActivityMessage,
	ActivityParticipant,
	ActivitySendOptions,
	ActivitySession,
} from '@app/features/activities/session/ActivitySessionTypes';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));

const SONG: BandSongSummary = {
	id: 'a',
	name: 'A',
	artist: 'Artist',
	lengthMs: 60_000,
	parts: {guitar: ['easy', 'medium'], drums: ['medium']},
	stems: false,
	coverUrl: null,
	packageUrl: 'https://dl.example/a.sng',
	packageBytes: 10,
	addedBy: null,
	groups: [],
	genre: null,
	year: null,
	previewStartMs: null,
};

const RESULT: Omit<BandPlayerResult, 'userId'> = {
	part: 'guitar',
	difficulty: 'easy',
	score: 100,
	rawScore: 100,
	accuracy: 0.5,
	bestStreak: 3,
	notesHit: 5,
	notesMissed: 5,
	starPowerUses: 0,
};

function participant(userId: string): ActivityParticipant {
	return {identity: `${userId}-conn`, userId, connectionId: 'conn', joinedAt: 0, isLocal: false};
}

// Shared room for the fake sessions: one leader, states broadcast to all, messages delivered synchronously.
class FakeRoom {
	readonly sessions: Array<FakeSession> = [];
	leaderUserId: string;
	now = 1_000_000;

	constructor(leaderUserId: string) {
		this.leaderUserId = leaderUserId;
	}

	join(userId: string): FakeSession {
		const session = new FakeSession(this, userId);
		this.sessions.push(session);
		return session;
	}

	leave(session: FakeSession): void {
		this.sessions.splice(this.sessions.indexOf(session), 1);
	}
}

class FakeSession {
	readonly me: ActivityParticipant;
	state: unknown = null;
	stateVersion = 0;
	readonly sent: Array<{payload: unknown; options?: ActivitySendOptions}> = [];
	private readonly handlers = new Set<(message: ActivityMessage) => void>();
	private seq = 0;

	constructor(
		private readonly room: FakeRoom,
		userId: string,
	) {
		this.me = {...participant(userId), isLocal: true};
	}

	get participants(): ReadonlyArray<ActivityParticipant> {
		return this.room.sessions.map((session) => session.me);
	}

	get leader(): ActivityParticipant | null {
		return this.room.sessions.find((session) => session.me.userId === this.room.leaderUserId)?.me ?? null;
	}

	get isLeader(): boolean {
		return this.room.leaderUserId === this.me.userId;
	}

	get clock() {
		return {offsetMs: 0, rttMs: 0, synced: true, now: () => this.room.now};
	}

	onMessage(handler: (message: ActivityMessage) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	async send(payload: unknown, options?: ActivitySendOptions): Promise<void> {
		this.sent.push({payload, options});
		const message: ActivityMessage = {from: {...this.me, isLocal: false}, seq: ++this.seq, payload};
		for (const session of this.room.sessions) {
			if (session === this || (options?.to && !options.to.includes(session.me.identity))) continue;
			for (const handler of session.handlers) handler(message);
		}
	}

	setState(state: unknown): boolean {
		if (!this.isLeader) return false;
		const wire = JSON.parse(JSON.stringify(state)) as unknown;
		for (const session of this.room.sessions) {
			session.state = wire;
			session.stateVersion++;
		}
		return true;
	}

	asSession(): ActivitySession {
		return this as unknown as ActivitySession;
	}
}

class ManualTimers implements BandControllerTimers {
	readonly callbacks = new Map<number, () => void>();
	private next = 0;

	setInterval(callback: () => void): unknown {
		this.callbacks.set(++this.next, callback);
		return this.next;
	}

	clearInterval(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}

	fire(): void {
		for (const callback of this.callbacks.values()) callback();
	}
}

function contextFor(room: FakeRoom): () => BandRoomContext {
	return () => ({
		leaderId: room.leaderUserId,
		presentUserIds: new Set(room.sessions.map((session) => session.me.userId)),
		songs: new Map([[SONG.id, SONG]]),
	});
}

function setup() {
	const room = new FakeRoom('lead');
	const leader = room.join('lead');
	const player = room.join('p1');
	const timers = new ManualTimers();
	const leaderController = new BandLeaderController(leader.asSession(), contextFor(room), timers);
	const playerController = new BandLeaderController(player.asSession(), contextFor(room), timers);
	leaderController.start();
	playerController.start();
	return {room, leader, player, timers, leaderController, playerController};
}

function phaseOf(state: unknown): string | undefined {
	return (state as BandState | null)?.phase;
}

describe('BandLeaderController', () => {
	it('opens song picking on the leader as soon as it starts', () => {
		const {leader, player, playerController} = setup();
		expect(phaseOf(leader.state)).toBe('pick');
		expect(playerController.state).toMatchObject({phase: 'pick', suggestions: ['a']});
		expect(player.stateVersion).toBe(1);
	});

	it('sends a non-leader intent to the leader only, and the leader applies it with the sender id', () => {
		const {player, playerController} = setup();
		playerController.sendIntent({t: 'band.vote', songId: 'a'});
		expect(player.sent).toEqual([{payload: {t: 'band.vote', songId: 'a'}, options: {to: ['lead-conn']}}]);
		expect(playerController.state).toMatchObject({phase: 'pick', votes: [{userId: 'p1', songId: 'a'}]});
	});

	it('applies the leader’s own intents locally', () => {
		const {leader, leaderController} = setup();
		leaderController.sendIntent({t: 'band.vote', songId: 'a'});
		expect(leader.sent).toEqual([]);
		expect(leaderController.state).toMatchObject({votes: [{userId: 'lead', songId: 'a'}]});
	});

	it('ignores malformed payloads and other band messages', async () => {
		const {leader, player} = setup();
		const version = leader.stateVersion;
		await player.send({t: 'band.vote'});
		await player.send({t: 'band.cheer', kind: 'clap'});
		await player.send({t: 'band.hit', part: 'guitar', noteIndex: 0, hit: true});
		expect(leader.stateVersion).toBe(version);
	});

	it('does not broadcast when an intent or tick changes nothing', () => {
		const {leader, timers, playerController} = setup();
		playerController.sendIntent({t: 'band.vote', songId: 'a'});
		const version = leader.stateVersion;
		playerController.sendIntent({t: 'band.vote', songId: 'nope'});
		timers.fire();
		expect(leader.stateVersion).toBe(version);
	});

	it('moves through the phases on its ticks', () => {
		const {room, timers, leaderController, playerController} = setup();
		room.now += 60_000;
		timers.fire();
		expect(leaderController.state?.phase).toBe('pick');
		playerController.sendIntent({t: 'band.vote', songId: 'a'});
		room.now += BAND_PHASE_MS.pick;
		timers.fire();
		expect(leaderController.state).toMatchObject({phase: 'select', songId: 'a'});
		leaderController.sendIntent({t: 'band.claimSeat', part: null});
		playerController.sendIntent({t: 'band.claimSeat', part: 'guitar'});
		playerController.sendIntent({t: 'band.loaded', songId: 'a'});
		playerController.sendIntent({t: 'band.ready', ready: true});
		expect(leaderController.state).toMatchObject({phase: 'play', startAt: room.now + 4000});
		room.now += BAND_PHASE_MS.countdown + SONG.lengthMs + BAND_PLAY_GRACE_MS;
		timers.fire();
		expect(leaderController.state?.phase).toBe('results');
	});

	it('ticks every 250 ms and stops cleanly', () => {
		const room = new FakeRoom('lead');
		const session = room.join('lead');
		const setIntervalSpy = vi.fn(() => 7);
		const clearIntervalSpy = vi.fn();
		const controller = new BandLeaderController(session.asSession(), contextFor(room), {
			setInterval: setIntervalSpy,
			clearInterval: clearIntervalSpy,
		});
		controller.start();
		controller.start();
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), BAND_TICK_MS);
		controller.stop();
		expect(clearIntervalSpy).toHaveBeenCalledWith(7);
	});

	it('never writes state while it is not the leader', () => {
		const {player, timers, room} = setup();
		const setState = vi.spyOn(player, 'setState');
		room.now += 60_000;
		timers.fire();
		expect(setState).not.toHaveBeenCalled();
	});

	it('hands over: the new leader continues from the last state and answers intents', () => {
		const {room, leader, player, timers, leaderController, playerController} = setup();
		const other = room.join('p2');
		const otherController = new BandLeaderController(other.asSession(), contextFor(room), timers);
		otherController.start();
		playerController.sendIntent({t: 'band.vote', songId: 'a'});
		room.now += BAND_PHASE_MS.pick;
		timers.fire();
		playerController.sendIntent({t: 'band.claimSeat', part: 'guitar'});
		playerController.sendIntent({t: 'band.loaded', songId: 'a'});
		expect(phaseOf(player.state)).toBe('select');

		leaderController.stop();
		room.leave(leader);
		room.leaderUserId = 'p1';
		timers.fire();
		expect(playerController.state).toMatchObject({phase: 'select', seats: [{userId: 'p1', part: 'guitar'}]});

		otherController.sendIntent({t: 'band.claimSeat', part: 'drums'});
		otherController.sendIntent({t: 'band.loaded', songId: 'a'});
		expect(other.sent.at(-1)?.options).toEqual({to: ['p1-conn']});
		expect(otherController.state).toMatchObject({
			seats: [
				{userId: 'p1', part: 'guitar'},
				{userId: 'p2', part: 'drums'},
			],
		});
		playerController.sendIntent({t: 'band.skip'});
		expect(phaseOf(other.state)).toBe('play');
	});

	it('hands over mid-song: results sent to the old leader survive and later ones reach the new leader', () => {
		const {room, leader, player, timers, leaderController, playerController} = setup();
		const other = room.join('p2');
		const otherController = new BandLeaderController(other.asSession(), contextFor(room), timers);
		otherController.start();
		playerController.sendIntent({t: 'band.vote', songId: 'a'});
		room.now += BAND_PHASE_MS.pick;
		timers.fire();
		leaderController.sendIntent({t: 'band.claimSeat', part: null});
		playerController.sendIntent({t: 'band.claimSeat', part: 'guitar'});
		otherController.sendIntent({t: 'band.claimSeat', part: 'drums'});
		playerController.sendIntent({t: 'band.loaded', songId: 'a'});
		otherController.sendIntent({t: 'band.loaded', songId: 'a'});
		playerController.sendIntent({t: 'band.ready', ready: true});
		otherController.sendIntent({t: 'band.ready', ready: true});
		expect(phaseOf(player.state)).toBe('play');
		room.now += BAND_PHASE_MS.countdown + SONG.lengthMs;
		playerController.sendIntent({t: 'band.result', result: RESULT});
		expect(phaseOf(player.state)).toBe('play');

		leaderController.stop();
		room.leave(leader);
		room.leaderUserId = 'p1';
		timers.fire();
		expect(phaseOf(player.state)).toBe('play');
		otherController.sendIntent({t: 'band.result', result: RESULT});
		expect(other.sent.at(-1)?.options).toEqual({to: ['p1-conn']});
		const results = playerController.state;
		expect(results?.phase === 'results' && results.results.map((result) => result.userId)).toEqual(['p1', 'p2']);
	});

	it('starts a fresh room when the new leader finds no usable state', () => {
		const room = new FakeRoom('p1');
		const session = room.join('p1');
		session.state = {phase: 'lobby'};
		const controller = new BandLeaderController(session.asSession(), contextFor(room), new ManualTimers());
		controller.start();
		expect(controller.state?.phase).toBe('pick');
	});

	it('drops my intent when there is no leader to send it to', () => {
		const room = new FakeRoom('gone');
		const session = room.join('p1');
		const controller = new BandLeaderController(session.asSession(), contextFor(room), new ManualTimers());
		controller.sendIntent({t: 'band.skip'});
		expect(session.sent).toEqual([]);
	});
});
