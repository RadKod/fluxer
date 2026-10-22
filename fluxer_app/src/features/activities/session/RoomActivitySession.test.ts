// SPDX-License-Identifier: AGPL-3.0-or-later

import {encodeActivityEnvelope} from '@app/features/activities/session/ActivityEnvelope';
import type {ActivityMessage} from '@app/features/activities/session/ActivitySessionTypes';
import {voiceActivityTopic} from '@fluxer/constants/src/VoiceActivityConstants';
import {type Room, RoomEvent} from 'livekit-client';
import {afterEach, beforeEach, describe, expect, it, type Mock, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));

const {RoomActivitySession} = await import('@app/features/activities/session/RoomActivitySession');

const SESSION = {activity_id: 'band', session_id: '77', started_by: '1', started_at: 0} as const;
const TOPIC = voiceActivityTopic(SESSION.session_id);
const ONE_WAY_MS = 20;

interface FakeParticipant {
	identity: string;
	joinedAt: Date;
}

type Listener = (...args: Array<unknown>) => void;
type PublishData = (
	data: Uint8Array,
	options: {topic?: string; destinationIdentities?: Array<string>},
) => Promise<void>;

class FakeRoom {
	readonly remoteParticipants = new Map<string, FakeParticipant>();
	readonly localParticipant: FakeParticipant & {publishData: Mock<PublishData>};
	private readonly listeners = new Map<string, Set<Listener>>();

	constructor(
		readonly network: FakeNetwork,
		identity: string,
		joinedAt: Date,
	) {
		this.localParticipant = {
			identity,
			joinedAt,
			publishData: vi.fn<PublishData>(async (data, options) => {
				network.deliver(identity, data, options.topic, options.destinationIdentities);
			}),
		};
	}

	on(event: string, listener: Listener): this {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)!.add(listener);
		return this;
	}

	off(event: string, listener: Listener): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}

	emit(event: string, ...args: Array<unknown>): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}

	asRoom(): Room {
		return this as unknown as Room;
	}
}

// Every message takes ONE_WAY_MS; a receiver gets it with its own view of the sender, as LiveKit does.
class FakeNetwork {
	readonly rooms = new Map<string, FakeRoom>();

	join(identity: string, joinedAtSeconds: number): FakeRoom {
		const room = new FakeRoom(this, identity, new Date(joinedAtSeconds * 1000));
		for (const other of this.rooms.values()) {
			room.remoteParticipants.set(other.localParticipant.identity, other.localParticipant);
			other.remoteParticipants.set(identity, room.localParticipant);
			other.emit(RoomEvent.ParticipantConnected, room.localParticipant);
		}
		this.rooms.set(identity, room);
		return room;
	}

	leave(identity: string): void {
		const room = this.rooms.get(identity);
		this.rooms.delete(identity);
		for (const other of this.rooms.values()) {
			other.remoteParticipants.delete(identity);
			other.emit(RoomEvent.ParticipantDisconnected, room?.localParticipant);
		}
	}

	deliver(from: string, data: Uint8Array, topic: string | undefined, to: Array<string> | undefined): void {
		for (const [identity, room] of this.rooms) {
			if (identity === from || (to && !to.includes(identity))) continue;
			setTimeout(() => {
				const sender = room.remoteParticipants.get(from);
				room.emit(RoomEvent.DataReceived, data, sender, undefined, topic);
			}, ONE_WAY_MS);
		}
	}
}

let network: FakeNetwork;
const sessions: Array<InstanceType<typeof RoomActivitySession>> = [];

function start(room: FakeRoom, {clockSkewMs = 0, joined = true}: {clockSkewMs?: number; joined?: boolean} = {}) {
	const session = new RoomActivitySession({
		room: room.asRoom(),
		channelId: '500',
		session: SESSION,
		end: vi.fn(async () => true),
		joined,
		localNow: () => Date.now() + clockSkewMs,
	});
	sessions.push(session);
	return session;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	network = new FakeNetwork();
});

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	vi.useRealTimers();
});

describe('RoomActivitySession', () => {
	it('lists the room and follows joins and leaves', () => {
		const starter = start(network.join('user_1_a', 100));
		const changes: Array<number> = [];
		starter.onParticipantsChanged((participants) => changes.push(participants.length));
		network.join('user_2_b', 50);
		expect(starter.participants.map((p) => p.identity)).toEqual(['user_1_a', 'user_2_b']);
		expect(starter.me).toMatchObject({identity: 'user_1_a', userId: '1', connectionId: 'a', isLocal: true});
		network.leave('user_2_b');
		expect(changes).toEqual([2, 1]);
	});

	it('keeps the starter as leader and hands over to the earliest joiner when they leave', () => {
		network.join('user_2_b', 50);
		const late = start(network.join('user_3_c', 200));
		network.join('user_1_a', 100);
		expect(late.leader?.identity).toBe('user_1_a');
		network.leave('user_1_a');
		expect(late.leader?.identity).toBe('user_2_b');
		expect(late.isLeader).toBe(false);
	});

	it('hands messages over with the LiveKit sender, not a claimed one', async () => {
		const starter = start(network.join('user_1_a', 100));
		const other = start(network.join('user_2_b', 200));
		const received: Array<ActivityMessage> = [];
		starter.onMessage((message) => received.push(message));
		await other.send({from: 'user_1_a', hello: true});
		await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
		expect(received).toHaveLength(1);
		expect(received[0].from.identity).toBe('user_2_b');
		expect(received[0].payload).toEqual({from: 'user_1_a', hello: true});
		expect(received[0].seq).toBeGreaterThan(0);
	});

	it('sends to the named identities only, on the session topic', async () => {
		const starter = start(network.join('user_1_a', 100));
		start(network.join('user_2_b', 200));
		const room = network.rooms.get('user_1_a')!;
		await starter.send({x: 1}, {to: ['user_2_b'], reliable: false});
		expect(room.localParticipant.publishData).toHaveBeenLastCalledWith(expect.any(Uint8Array), {
			reliable: false,
			topic: TOPIC,
			destinationIdentities: ['user_2_b'],
		});
	});

	it('ignores another session topic', async () => {
		const starter = start(network.join('user_1_a', 100));
		network.join('user_2_b', 200);
		const handler = vi.fn();
		starter.onMessage(handler);
		const room = network.rooms.get('user_1_a')!;
		room.emit(
			RoomEvent.DataReceived,
			encodeActivityEnvelope('app', 1, {}),
			room.remoteParticipants.get('user_2_b'),
			undefined,
			'activity:other',
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it('measures the offset to the leader clock', async () => {
		start(network.join('user_1_a', 100));
		// This client's clock runs 5 s behind the leader's.
		const follower = start(network.join('user_2_b', 200), {clockSkewMs: -5_000});
		expect(follower.clock.synced).toBe(false);
		await vi.advanceTimersByTimeAsync(6 * 2 * ONE_WAY_MS + 10);
		expect(follower.clock.synced).toBe(true);
		expect(follower.clock.offsetMs).toBe(5_000);
		expect(follower.clock.rttMs).toBe(2 * ONE_WAY_MS);
		expect(follower.clock.now()).toBe(Date.now());
	});

	it('is the clock reference as leader', () => {
		const starter = start(network.join('user_1_a', 100), {clockSkewMs: 1_234});
		expect(starter.clock).toMatchObject({synced: true, offsetMs: 0});
		expect(starter.clock.now()).toBe(Date.now() + 1_234);
	});

	it('gives a late joiner the leader state and takes state from the leader only', async () => {
		const starter = start(network.join('user_1_a', 100));
		expect(starter.setState({song: 'snow'})).toBe(true);
		const late = start(network.join('user_2_b', 200));
		await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
		expect(late.state).toEqual({song: 'snow'});
		expect(late.stateVersion).toBe(1);

		expect(late.setState({song: 'mine'})).toBe(false);
		// A follower that forges a state broadcast is not listened to.
		const forged = encodeActivityEnvelope('state', 99, {v: 50, s: {song: 'forged'}});
		await network.rooms.get('user_2_b')!.localParticipant.publishData(forged, {topic: TOPIC});
		await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
		expect(starter.state).toEqual({song: 'snow'});

		const seen: Array<unknown> = [];
		late.onStateChanged((state) => seen.push(state));
		starter.setState({song: 'one'});
		await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
		expect(late.state).toEqual({song: 'one'});
		expect(late.stateVersion).toBe(2);
		expect(seen).toEqual([{song: 'one'}]);
	});

	it('asks again when the leader did not see the request', async () => {
		start(network.join('user_1_a', 100));
		const late = start(network.join('user_2_b', 200));
		const leaderRoom = network.rooms.get('user_1_a')!;
		// The leader's room does not know the joiner yet: its first request is dropped.
		leaderRoom.remoteParticipants.delete('user_2_b');
		await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
		leaderRoom.remoteParticipants.set('user_2_b', network.rooms.get('user_2_b')!.localParticipant);
		const requests = () =>
			network.rooms
				.get('user_2_b')!
				.localParticipant.publishData.mock.calls.filter(([data]) =>
					new TextDecoder().decode(data).includes('"state_req"'),
				);
		expect(requests()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2_000 + 2 * ONE_WAY_MS);
		expect(requests()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(requests()).toHaveLength(2);
		expect(late.stateVersion).toBe(0);
	});

	it('refuses an oversized state before changing anything', () => {
		const starter = start(network.join('user_1_a', 100));
		expect(() => starter.setState('x'.repeat(20_000))).toThrow(RangeError);
		expect(starter.stateVersion).toBe(0);
	});

	it('defaults to capturing the keyboard and lets the activity release it', () => {
		const starter = start(network.join('user_1_a', 100));
		expect(starter.keyboardCaptured).toBe(true);
		starter.captureKeyboard(false);
		expect(starter.keyboardCaptured).toBe(false);
	});

	it('stops listening to the room once disposed', async () => {
		const starter = start(network.join('user_1_a', 100));
		const other = start(network.join('user_2_b', 200));
		const handler = vi.fn();
		starter.onMessage(handler);
		starter.dispose();
		await other.send({late: true});
		await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
		expect(handler).not.toHaveBeenCalled();
	});
	describe('membership', () => {
		it('counts only the connections that joined, and tells everyone when I join or leave', async () => {
			const starter = start(network.join('user_1_a', 100));
			const chatter = start(network.join('user_2_b', 50), {joined: false});
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			expect(starter.members.map((member) => member.identity)).toEqual(['user_1_a']);
			expect(chatter.members.map((member) => member.identity)).toEqual(['user_1_a']);
			expect(chatter.joined).toBe(false);

			const seen: Array<number> = [];
			starter.onMembersChanged((members) => seen.push(members.length));
			chatter.setJoined(true);
			await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
			expect(starter.members.map((member) => member.identity)).toEqual(['user_1_a', 'user_2_b']);
			chatter.setJoined(false);
			await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
			expect(starter.members.map((member) => member.identity)).toEqual(['user_1_a']);
			expect(seen).toEqual([2, 1]);
		});

		it('elects the leader among members only, so chatting in the channel never leads', async () => {
			const chatter = start(network.join('user_2_b', 50), {joined: false});
			const starter = start(network.join('user_1_a', 100), {joined: false});
			const player = start(network.join('user_3_c', 200));
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			for (const session of [chatter, starter, player]) expect(session.leader?.identity).toBe('user_3_c');
			expect(player.isLeader).toBe(true);

			starter.setJoined(true);
			await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
			for (const session of [chatter, starter, player]) expect(session.leader?.identity).toBe('user_1_a');
		});

		it('passes leadership to the member who has been in the room longest when the leader leaves the activity', async () => {
			const starter = start(network.join('user_1_a', 300));
			const late = start(network.join('user_3_c', 200));
			const early = start(network.join('user_2_b', 100));
			const chatter = start(network.join('user_4_d', 50), {joined: false});
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			expect(late.leader?.identity).toBe('user_1_a');

			starter.setJoined(false);
			await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
			for (const session of [starter, late, early, chatter]) expect(session.leader?.identity).toBe('user_2_b');
			expect(early.isLeader).toBe(true);
			expect(early.clock).toMatchObject({synced: true, offsetMs: 0});
		});

		it('has no leader while nobody takes part', async () => {
			const starter = start(network.join('user_1_a', 100), {joined: false});
			const other = start(network.join('user_2_b', 200), {joined: false});
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			expect(starter.members).toEqual([]);
			expect(other.leader).toBeNull();
			expect(starter.setState({x: 1})).toBe(false);
		});

		it('learns the membership of a room it joins late', async () => {
			start(network.join('user_1_a', 100));
			start(network.join('user_2_b', 200), {joined: false});
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			const late = start(network.join('user_3_c', 300), {joined: false});
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			expect(late.members.map((member) => member.identity)).toEqual(['user_1_a']);
			expect(late.leader?.identity).toBe('user_1_a');
		});

		it('hears from a newcomer whose session started before I saw it join', async () => {
			const starter = start(network.join('user_1_a', 100));
			const starterRoom = network.rooms.get('user_1_a')!;
			const chatterRoom = network.join('user_2_b', 200);
			starterRoom.remoteParticipants.delete('user_2_b');
			start(chatterRoom, {joined: false});
			await vi.advanceTimersByTimeAsync(ONE_WAY_MS);
			// The announcement was dropped; the participant is counted in until it says otherwise.
			starterRoom.remoteParticipants.set('user_2_b', chatterRoom.localParticipant);
			starterRoom.emit(RoomEvent.ParticipantConnected, chatterRoom.localParticipant);
			expect(starter.members.map((member) => member.identity)).toEqual(['user_1_a', 'user_2_b']);
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			expect(starter.members.map((member) => member.identity)).toEqual(['user_1_a']);
		});

		it('counts a client from before the join step in, as it plays whenever it is in the room', async () => {
			const starter = start(network.join('user_1_a', 100), {joined: false});
			network.join('user_2_b', 50);
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			expect(starter.members.map((member) => member.identity)).toEqual(['user_2_b']);
			expect(starter.leader?.identity).toBe('user_2_b');
		});

		it('forgets what a participant said once it leaves the room', async () => {
			const starter = start(network.join('user_1_a', 100));
			start(network.join('user_2_b', 200), {joined: false});
			await vi.advanceTimersByTimeAsync(2 * ONE_WAY_MS);
			network.leave('user_2_b');
			// The same identity back without a session is an unknown client again.
			network.join('user_2_b', 400);
			expect(starter.members.map((member) => member.identity)).toEqual(['user_1_a', 'user_2_b']);
		});
	});
});
