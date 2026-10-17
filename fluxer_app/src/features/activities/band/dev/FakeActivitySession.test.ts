// SPDX-License-Identifier: AGPL-3.0-or-later

import {FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import type {ActivityMessage} from '@app/features/activities/session/ActivitySessionTypes';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const LATENCY_MS = 25;

function createSession(overrides: {lossyDropRate?: number; random?: () => number} = {}) {
	return new FakeActivitySession({
		activityId: 'band',
		myUserId: '100',
		localNow: () => Date.now(),
		latencyMs: LATENCY_MS,
		...overrides,
	});
}

describe('FakeActivitySession', () => {
	beforeEach(() => {
		vi.useFakeTimers({now: 1_700_000_000_000});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('makes me the leader with a synced zero-offset clock', () => {
		const session = createSession();
		expect(session.isLeader).toBe(true);
		expect(session.leader?.identity).toBe(session.me.identity);
		expect(session.me.identity).toBe(`user_100_${session.me.connectionId}`);
		expect(session.clock.synced).toBe(true);
		expect(session.clock.now()).toBe(Date.now());
	});

	it('keeps me the leader as peers join and reports the roster', () => {
		const session = createSession();
		const rosters: Array<number> = [];
		session.onParticipantsChanged((participants) => rosters.push(participants.length));
		const peer = session.connectPeer('200');
		session.connectPeer('300');
		expect(session.participants).toHaveLength(3);
		expect(session.isLeader).toBe(true);
		peer.leave();
		expect(session.participants.map((participant) => participant.userId).sort()).toEqual(['100', '300']);
		expect(rosters).toEqual([2, 3, 2]);
	});

	it('delivers a peer message to me after the latency, with the peer as sender', () => {
		const session = createSession();
		const peer = session.connectPeer('200');
		const received: Array<ActivityMessage> = [];
		session.onMessage((message) => received.push(message));
		peer.send({t: 'band.vote', songId: 'a'});
		expect(received).toHaveLength(0);
		vi.advanceTimersByTime(LATENCY_MS);
		expect(received).toEqual([{from: peer.participant, seq: 1, payload: {t: 'band.vote', songId: 'a'}}]);
	});

	it('never echoes a message to its sender and honours `to`', () => {
		const session = createSession();
		const a = session.connectPeer('200');
		const b = session.connectPeer('300');
		const toA = vi.fn();
		const toB = vi.fn();
		const toMe = vi.fn();
		a.onMessage(toA);
		b.onMessage(toB);
		session.onMessage(toMe);

		a.send({n: 1});
		void session.send({n: 2}, {to: [b.participant.identity]});
		vi.advanceTimersByTime(LATENCY_MS);

		expect(toA).not.toHaveBeenCalled();
		expect(toMe).toHaveBeenCalledTimes(1);
		expect(toB.mock.calls.map(([message]) => message.payload)).toEqual([{n: 1}, {n: 2}]);
	});

	it('passes payloads through JSON, as the room does', () => {
		const session = createSession();
		const peer = session.connectPeer('200');
		const received = vi.fn();
		session.onMessage(received);
		peer.send({at: undefined, keep: 1});
		vi.advanceTimersByTime(LATENCY_MS);
		expect(received.mock.calls[0][0].payload).toEqual({keep: 1});
		expect(() => peer.send({big: 'x'.repeat(20_000)})).toThrow(RangeError);
	});

	it('drops lossy messages at the configured rate and keeps reliable ones', () => {
		const session = createSession({lossyDropRate: 1});
		const peer = session.connectPeer('200');
		const received = vi.fn();
		session.onMessage(received);
		peer.send({lossy: true}, {reliable: false});
		peer.send({lossy: false});
		vi.advanceTimersByTime(LATENCY_MS);
		expect(received.mock.calls.map(([message]) => message.payload)).toEqual([{lossy: false}]);
	});

	it('applies state at once for me and after the latency for peers', () => {
		const session = createSession();
		const peer = session.connectPeer('200');
		vi.advanceTimersByTime(LATENCY_MS);
		const peerStates: Array<unknown> = [];
		peer.onStateChanged((state) => peerStates.push(state));

		expect(session.setState({phase: 'vote'})).toBe(true);
		expect(session.state).toEqual({phase: 'vote'});
		expect(session.stateVersion).toBe(1);
		expect(peer.state).toBeNull();
		vi.advanceTimersByTime(LATENCY_MS);
		expect(peer.state).toEqual({phase: 'vote'});
		expect(peerStates).toEqual([{phase: 'vote'}]);
	});

	it('hands a late joiner the current state', () => {
		const session = createSession();
		session.setState({phase: 'play'});
		const peer = session.connectPeer('200');
		vi.advanceTimersByTime(LATENCY_MS);
		expect(peer.state).toEqual({phase: 'play'});
	});

	it('stops delivering after end', async () => {
		const session = createSession();
		const peer = session.connectPeer('200');
		const received = vi.fn();
		session.onMessage(received);
		peer.send({n: 1});
		await expect(session.end()).resolves.toBe(true);
		vi.advanceTimersByTime(LATENCY_MS);
		expect(received).not.toHaveBeenCalled();
		expect(session.setState({})).toBe(false);
	});
});
